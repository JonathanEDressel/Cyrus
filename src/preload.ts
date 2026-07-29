import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cyrus', {
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
  showItemInFolder: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke('show-item-in-folder', filePath),
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
