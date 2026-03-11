import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess | null = null;

function getBackendPath(): string {
  const isDev = !app.isPackaged;
  
  if (isDev) {
    // Development: Python script (run manually)
    return '';
  } else {
    // Production: Bundled executable in resources
    return path.join(process.resourcesPath, 'backend', 'KrakingServer.exe');
  }
}

function getDbPath(): string {
  // Store database in user's app data folder
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
  
  if (!fs.existsSync(backendPath)) {
    console.error('[ERROR] Backend executable not found:', backendPath);
    return;
  }
  
  const dbPath = getDbPath();
  console.log('[BACKEND] Starting with DB at:', dbPath);
  
  const env = {
    ...process.env,
    DATABASE_PATH: dbPath,
    SECRET_KEY: process.env.SECRET_KEY || 'your-secret-key-here-change-in-production',
    API_PORT: '5000'
  };
  
  backendProcess = spawn(backendPath, [], {
    env,
    windowsHide: true
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
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // In production, index.html is in src/ directory relative to resources
  // In development, index.html is in src/ directory
  const isDev = !app.isPackaged;
  const indexPath = isDev 
    ? path.join(__dirname, '../index.html')
    : path.join(__dirname, '../src/index.html');

  mainWindow.loadFile(indexPath);

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
