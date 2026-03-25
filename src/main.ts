import { app, BrowserWindow, shell } from 'electron';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess | null = null;

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
    return;
  }
  
  const backendPath = getBackendPath();
  
  console.log('[BACKEND] Looking for backend at:', backendPath);
  
  if (!fs.existsSync(backendPath)) {
    console.error('[ERROR] Backend executable not found:', backendPath);
    console.error('[ERROR] resourcesPath:', process.resourcesPath);
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
    API_PORT: '5000'
  };
  
  console.log('[BACKEND] Starting backend server...');
  
  backendProcess = spawn(backendPath, [], {
    env,
    windowsHide: false  
  });
  
  backendProcess.stdout?.on('data', (data) => {
    console.log(`[BACKEND] ${data}`);
  });

  backendProcess.stderr?.on('data', (data) => {
    console.error(`[BACKEND ERROR] ${data}`);
  });
  
  backendProcess.on('close', (code) => {
    console.log(`[BACKEND] Process exited with code ${code}`);
    backendProcess = null;
  });
  
  backendProcess.on('error', (err) => {
    console.error(`[BACKEND] Failed to start:`, err);
  });
}

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
