import { app, BrowserWindow, shell, ipcMain, Tray, Menu, nativeImage, dialog } from 'electron';
import * as path from 'path';
import { spawn, execFileSync, ChildProcess } from 'child_process';
import * as fs from 'fs';

const PREFERRED_PORT = 5000;

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess | null = null;

// Tray state. Closing the window hides it instead of quitting, so automations
// keep running — the backend is only stopped by an explicit Quit.
let tray: Tray | null = null;
let isQuitting = false;
let workerState = 'unknown';
let trayPollTimer: NodeJS.Timeout | null = null;
let toldUserAboutTray = false;

// The backend binds to PREFERRED_PORT when free, otherwise an OS-assigned
// port, then prints `CYRUS_PORT=<n>`. The renderer asks for the resolved port
// via the `get-backend-port` IPC channel before making any API calls.
let backendPort: number | null = null;
let resolveBackendPort!: (port: number) => void;
const backendPortReady = new Promise<number>((resolve) => {
  resolveBackendPort = resolve;
});

function setBackendPort(port: number): void {
  if (backendPort === null) {
    backendPort = port;
    console.log('[BACKEND] Resolved API port:', port);
    resolveBackendPort(port);
  }
}

function getBackendPath(): string {
  const isDev = !app.isPackaged;
  
  if (isDev) {
    return '';
  } else {
    return path.join(process.resourcesPath, 'backend', 'CyrusServer.exe');
  }
}

function getDbPath(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'kraking.db');
}

/**
 * Kill any CyrusServer.exe left behind by a previous run.
 *
 * A crashed or force-quit Electron orphans the backend, which keeps holding
 * PREFERRED_PORT. The next launch then finds 5000 taken and silently talks to
 * the stale process — potentially a build from weeks ago — instead of the one
 * it just spawned. Newer backends self-exit via CYRUS_PARENT_PID; this sweeps
 * up orphans from versions that predate that watchdog.
 *
 * Only runs when packaged: in dev the backend is started by hand and killing it
 * out from under the developer would be hostile.
 */
function killStaleBackends(): void {
  if (!app.isPackaged || process.platform !== 'win32') return;
  try {
    execFileSync('taskkill', ['/F', '/T', '/IM', 'CyrusServer.exe'], { stdio: 'ignore' });
    console.log('[BACKEND] Cleaned up stale CyrusServer process(es)');
  } catch {
    // Non-zero exit just means there was nothing to kill.
  }
}

function startBackend() {
  const isDev = !app.isPackaged;

  if (isDev) {
    console.log('[DEV] Start backend manually: cd src/backend && python Server.py');
    // In dev the backend is launched manually and defaults to PREFERRED_PORT.
    setBackendPort(PREFERRED_PORT);
    return;
  }

  const backendPath = getBackendPath();

  console.log('[BACKEND] Looking for backend at:', backendPath);

  if (!fs.existsSync(backendPath)) {
    console.error('[ERROR] Backend executable not found:', backendPath);
    console.error('[ERROR] resourcesPath:', process.resourcesPath);
    // Unblock the renderer rather than leaving it waiting forever.
    setBackendPort(PREFERRED_PORT);
    return;
  }
  
  const dbPath = getDbPath();
  console.log('[BACKEND] Database will be created at:', dbPath);
  
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    console.log('[BACKEND] Creating directory:', dbDir);
    fs.mkdirSync(dbDir, { recursive: true });
  }
  
  // Clear out any orphan still holding the port before claiming it ourselves.
  killStaleBackends();

  const env = {
    ...process.env,
    DATABASE_PATH: dbPath,
    SECRET_KEY: process.env.SECRET_KEY || 'your-secret-key-here-change-in-production',
    API_PORT: String(PREFERRED_PORT),
    // The backend watches this PID and exits when we do, so a crash on our side
    // can't leave a stale server squatting on the port.
    CYRUS_PARENT_PID: String(process.pid)
  };

  console.log('[BACKEND] Starting backend server...');

  backendProcess = spawn(backendPath, [], {
    env,
    windowsHide: false
  });

  // stdout 'data' events are not line-buffered — accumulate and only parse the
  // port from a complete, newline-terminated line, otherwise a chunk boundary
  // in the middle of the number (e.g. "CYRUS_PORT=512" then "34\n") would match
  // "\d+" = 512 and lock in a wrong, dead port permanently.
  let stdoutBuffer = '';
  backendProcess.stdout?.on('data', (data) => {
    const text = data.toString();
    console.log(`[BACKEND] ${text}`);
    stdoutBuffer += text;
    let nl: number;
    while ((nl = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, nl);
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      const match = line.match(/CYRUS_PORT=(\d+)/);
      if (match) {
        setBackendPort(parseInt(match[1], 10));
      }
    }
  });

  backendProcess.stderr?.on('data', (data) => {
    console.error(`[BACKEND ERROR] ${data}`);
  });

  backendProcess.on('close', (code) => {
    console.log(`[BACKEND] Process exited with code ${code}`);
    backendProcess = null;
    // If it died before announcing a port, unblock the renderer.
    setBackendPort(PREFERRED_PORT);
  });

  backendProcess.on('error', (err) => {
    console.error(`[BACKEND] Failed to start:`, err);
    setBackendPort(PREFERRED_PORT);
  });
}

// Renderer calls this (via the preload bridge) before making API requests so
// it always targets the port the backend actually bound to.
ipcMain.handle('get-backend-port', async () => {
  if (backendPort !== null) {
    return backendPort;
  }
  return backendPortReady;
});

// Capture a region of the rendered window as a PNG data URL. Used by the
// monthly-report builder to snapshot charts with full fidelity (the renderer
// briefly shows each chart on-screen, then asks us to grab its rect).
ipcMain.handle('capture-region', async (_event, rect: { x: number; y: number; width: number; height: number }) => {
  if (!mainWindow) return null;
  try {
    const image = await mainWindow.webContents.capturePage({
      x: Math.max(0, Math.round(rect.x)),
      y: Math.max(0, Math.round(rect.y)),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    });
    return image.toDataURL();
  } catch (err) {
    console.error('[CAPTURE] capturePage failed:', err);
    return null;
  }
});

// Save the Robinhood key-generator script somewhere the user chooses.
//
// Robinhood issues no secret — you generate an Ed25519 keypair and register the
// public half — and some people quite reasonably prefer to generate their own
// keys rather than have an app do it. The script is dependency-free (pure-Python
// Ed25519 when PyNaCl isn't around), so it runs on any Python 3 and needs no
// network. Copying it out is a plain file write; the renderer never gets fs
// access.
ipcMain.handle('save-keygen-script', async (_event, exchange: string) => {
  const scripts: Record<string, string> = {
    robinhood: 'robinhood_keygen.py',
  };
  const filename = scripts[String(exchange || '').toLowerCase()];
  if (!filename) {
    return { saved: false, error: 'No key generator is available for that exchange.' };
  }

  const source = path.join(__dirname, '../src/assets/tools', filename);

  try {
    const options = {
      title: 'Save key generator',
      defaultPath: path.join(app.getPath('downloads'), filename),
      filters: [{ name: 'Python script', extensions: ['py'] }],
    };
    // Parent it to the window when there is one, so the dialog is modal.
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      return { saved: false, canceled: true };
    }

    // Read-then-write rather than copyFile: inside a packaged build the source
    // lives in app.asar, which fs can read but isn't a real path on disk.
    const contents = fs.readFileSync(source);
    fs.writeFileSync(result.filePath, contents);
    return { saved: true, path: result.filePath };
  } catch (err: any) {
    console.error('[KEYGEN] Could not save script:', err);
    return { saved: false, error: err?.message || 'Could not save the file.' };
  }
});

// Reveal a saved file in Explorer, so "where did it go?" needs no answer.
ipcMain.handle('show-item-in-folder', async (_event, filePath: string) => {
  if (!filePath) return false;
  shell.showItemInFolder(filePath);
  return true;
});

// ─── Tray, autostart, and close-to-tray ─────────────────────────────────────
// Automations only run while the backend is alive, so quitting on window-close
// silently disables everything the user set up. The window now hides to the
// tray instead, and the tray shows whether the engine is actually running.

const TRAY_STATE_LABEL: Record<string, string> = {
  healthy: 'Automations running',
  starting: 'Automations starting…',
  late: 'Automations delayed',
  stalled: 'Automations STOPPED',
  stopped: 'Automations not running',
  not_started: 'Automations not running',
  unknown: 'Connecting…',
};

function iconPath(): string {
  return path.join(__dirname, '../src/assets/icon.ico');
}

function setAutoStart(enabled: boolean): void {
  // '--hidden' lets a login-launched instance boot straight to the tray rather
  // than throwing a window in the user's face at every sign-in.
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    args: ['--hidden'],
  });
}

function showMainWindow(): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

function buildTrayMenu(): Menu {
  const statusLabel = TRAY_STATE_LABEL[workerState] ?? 'Unknown';
  return Menu.buildFromTemplate([
    { label: `Cyrus — ${statusLabel}`, enabled: false },
    { type: 'separator' },
    { label: 'Open Cyrus', click: () => showMainWindow() },
    {
      label: 'Start Cyrus at login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        setAutoStart(item.checked);
        refreshTray();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Cyrus (stops automations)',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function refreshTray(): void {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
  tray.setToolTip(`Cyrus — ${TRAY_STATE_LABEL[workerState] ?? 'Unknown'}`);
}

function createTray(): void {
  if (tray) return;
  // Fully defensive: a missing/corrupt icon must never stop the app from
  // starting. Electron throws on Tray() with an empty image, so bail instead —
  // the app still works, it just loses close-to-tray (see the close handler).
  try {
    const image = nativeImage.createFromPath(iconPath());
    if (image.isEmpty()) {
      console.error('[TRAY] Icon not found at', iconPath(), '- tray disabled');
      return;
    }
    tray = new Tray(image);
    tray.on('click', () => showMainWindow());
    tray.on('double-click', () => showMainWindow());
    refreshTray();
  } catch (err) {
    console.error('[TRAY] Could not create tray icon:', err);
    tray = null;
  }
}

/** Poll the backend's unauthenticated health probe so the tray can show engine
 *  state even with the window closed and nobody logged in. */
async function pollWorkerState(): Promise<void> {
  if (backendPort === null) return;
  const previous = workerState;
  try {
    const res = await fetch(`http://127.0.0.1:${backendPort}/api/health`, {
      signal: AbortSignal.timeout(4000),
    });
    const body: any = await res.json();
    workerState = body?.worker?.state ?? 'unknown';
  } catch {
    workerState = 'unknown';
  }
  if (workerState !== previous) refreshTray();
}

function startTrayPolling(): void {
  if (trayPollTimer) return;
  void pollWorkerState();
  trayPollTimer = setInterval(() => void pollWorkerState(), 30000);
}

function notifyHiddenToTray(): void {
  if (toldUserAboutTray || !tray) return;
  toldUserAboutTray = true;
  try {
    tray.displayBalloon({
      title: 'Cyrus is still running',
      content: 'Your automations keep running in the background. Quit from the tray icon to stop them.',
      icon: nativeImage.createFromPath(iconPath()),
    });
  } catch {
    // Balloons are best-effort; some Windows configurations suppress them.
  }
}

function createWindow(startHidden = false) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.join(__dirname, '../src/assets/icon.ico'),
    show: false,
    // Without an explicit backing colour the window starts with no opaque
    // surface, which on Windows leaves Chromium computing damage rects against
    // an empty root layer — regions redrawn after the first paint (a table
    // whose rows were just replaced) can stay stale until something else
    // invalidates them. Matches --bg-primary so there's no flash on show.
    backgroundColor: '#0f172a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  const indexPath = path.join(__dirname, '../src/index.html');

  mainWindow.loadFile(indexPath);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('file://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => {
    if (startHidden) return;   // launched at login: stay in the tray
    mainWindow?.maximize();
    mainWindow?.show();
  });

  // Hide rather than close, so the backend (and therefore every automation)
  // survives the user clicking X. Quit is an explicit tray action.
  mainWindow.on('close', (e) => {
    // Without a tray there'd be no way to get the window back, so only
    // hide-on-close when there's actually an icon to restore from.
    if (isQuitting || !tray) return;
    e.preventDefault();
    mainWindow?.hide();
    notifyHiddenToTray();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// A second launch would spawn a second backend — and killStaleBackends() would
// take out the first one's, stopping automations. Focus the running instance
// instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.on('ready', () => {
    startBackend();
    // Last-resort fallback: if the backend never announces a port (and never
    // exits), don't leave the renderer hanging — fall back to the preferred port.
    setTimeout(() => setBackendPort(PREFERRED_PORT), 20000);
    createTray();
    startTrayPolling();
    const startHidden = process.argv.includes('--hidden');
    setTimeout(() => createWindow(startHidden), 2000);
  });
}

app.on('window-all-closed', () => {
  // With a tray, deliberately do NOT quit — that's what keeps the automation
  // worker alive after the user closes the window. Quitting then happens only
  // via the tray's Quit item. If the tray failed to create there's no way back
  // to the window, so fall back to conventional quit-on-close.
  if ((isQuitting || !tray) && process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (trayPollTimer) {
    clearInterval(trayPollTimer);
    trayPollTimer = null;
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
  if (backendProcess) {
    console.log('[BACKEND] Stopping...');
    // On Windows a plain kill() can leave the process tree behind; taskkill /T
    // takes the children with it. The backend's parent watchdog is the backstop
    // if this somehow doesn't land.
    if (process.platform === 'win32' && backendProcess.pid) {
      try {
        execFileSync('taskkill', ['/F', '/T', '/PID', String(backendProcess.pid)], { stdio: 'ignore' });
      } catch {
        backendProcess.kill();
      }
    } else {
      backendProcess.kill();
    }
    backendProcess = null;
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
