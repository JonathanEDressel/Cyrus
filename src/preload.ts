import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cyrus', {
  // 'win32' | 'darwin' | … — lets the UI show platform-appropriate hints
  // (⌘K on macOS, Ctrl K elsewhere).
  platform: process.platform,
  getBackendPort: (): Promise<number> => ipcRenderer.invoke('get-backend-port'),
  // Screenshot a region of the window (CSS-px rect) — used to capture charts
  // for the monthly report with full fidelity (fonts/icons/CSS). Returns a PNG
  // data URL, or null on failure.
  captureRegion: (rect: { x: number; y: number; width: number; height: number }): Promise<string | null> =>
    ipcRenderer.invoke('capture-region', rect),
  // Save the bundled key-generator script for an exchange to a location the
  // user picks. Returns { saved, path? , canceled?, error? }.
  saveKeygenScript: (exchange: string): Promise<{
    saved: boolean; path?: string; canceled?: boolean; error?: string;
  }> => ipcRenderer.invoke('save-keygen-script', exchange),
  // Save renderer-produced bytes (base64) wherever the user chooses. Used for
  // the wallet import template. Returns { saved, path?, canceled?, error? }.
  saveFile: (args: {
    defaultName: string; base64: string; filterName?: string; extensions?: string[];
  }): Promise<{ saved: boolean; path?: string; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('save-file', args),
  showItemInFolder: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke('show-item-in-folder', filePath),
  // App updates (src/updater.ts). State is pushed on every change; the
  // renderer also asks once on load in case the check ran before it existed.
  updates: {
    state: (): Promise<any> => ipcRenderer.invoke('update-state'),
    check: (): Promise<any> => ipcRenderer.invoke('update-check'),
    download: (): Promise<any> => ipcRenderer.invoke('update-download'),
    install: (): Promise<void> => ipcRenderer.invoke('update-install'),
    openDownload: (): Promise<void> => ipcRenderer.invoke('update-open'),
    onChange: (cb: (state: any) => void): void => {
      ipcRenderer.on('update-state', (_event, state) => cb(state));
    },
  },
});

contextBridge.exposeInMainWorld('api', {
  send: (channel: string, data: any) => {
    const validChannels = ['toMain'];
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },
  receive: (channel: string, func: Function) => {
    const validChannels = ['fromMain'];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (event, ...args) => func(...args));
    }
  },
});
