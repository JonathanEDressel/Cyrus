import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cyrus', {
  getBackendPort: (): Promise<number> => ipcRenderer.invoke('get-backend-port'),
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
