import { app, BrowserWindow, shell, ipcMain } from 'electron';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';

const PREFERRED_PORT = 5000;

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess | null = null;

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
  
  const env = {
    ...process.env,
    DATABASE_PATH: dbPath,
    SECRET_KEY: process.env.SECRET_KEY || 'your-secret-key-here-change-in-production',
    API_PORT: String(PREFERRED_PORT)
  };

  console.log('[BACKEND] Starting backend server...');

  backendProcess = spawn(backendPath, [], {
    env,
    windowsHide: false
  });

  backendProcess.stdout?.on('data', (data) => {
    const text = data.toString();
    console.log(`[BACKEND] ${text}`);
    const match = text.match(/CYRUS_PORT=(\d+)/);
    if (match) {
      setBackendPort(parseInt(match[1], 10));
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.join(__dirname, '../src/assets/icon.ico'),
    show: false,
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
    mainWindow?.maximize();
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('ready', () => {
  startBackend();
  // Last-resort fallback: if the backend never announces a port (and never
  // exits), don't leave the renderer hanging — fall back to the preferred port.
  setTimeout(() => setBackendPort(PREFERRED_PORT), 20000);
  setTimeout(createWindow, 2000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (backendProcess) {
    console.log('[BACKEND] Stopping...');
    backendProcess.kill();
    backendProcess = null;
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
