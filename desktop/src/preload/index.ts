import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type AliaApi, type PushMessage } from '../shared/ipc';

/** The only door from the page to the rest of the app. Every call here is validated again in main. */
const api: AliaApi = {
  request: (name, payload) => ipcRenderer.invoke(CHANNELS.request, name, payload),
  onMessage(listener) {
    const handler = (_event: unknown, message: PushMessage) => listener(message);
    ipcRenderer.on(CHANNELS.push, handler);
    return () => ipcRenderer.removeListener(CHANNELS.push, handler);
  },
  ping: () => ipcRenderer.invoke(CHANNELS.ping),
};

contextBridge.exposeInMainWorld('alia', api);
