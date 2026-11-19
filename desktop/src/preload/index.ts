/// <reference lib="dom" />
import { contextBridge, ipcRenderer, webUtils } from 'electron';
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

/*
 * Files dropped on the window. The page never gets file paths (it only sees File objects), and it cannot ask for the
 * path of one: this script, which runs apart from the page, resolves them and tells main. It listens for `drop` itself
 * and acts only on a genuine user drop (`isTrusted`): a page that dispatches a fake drop event gets nothing.
 */
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => {
  event.preventDefault();
  if (!event.isTrusted) return;
  const paths: string[] = [];
  for (const file of Array.from(event.dataTransfer?.files ?? [])) {
    try {
      const p = webUtils.getPathForFile(file);
      if (p) paths.push(p);
    } catch {
      /* a File that is not on disk has no path */
    }
  }
  if (paths.length > 0) ipcRenderer.send(CHANNELS.dropped, paths);
});
