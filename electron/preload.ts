// The only bridge between the page and the desktop app: four functions on `window.desktop`.
// The page stays an ordinary sandboxed web page (no Node, context-isolated).
import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from '../src/shared/desktopApi';

const VERSION_FLAG = '--photobook-version=';
const version = process.argv.find((a) => a.startsWith(VERSION_FLAG))?.slice(VERSION_FLAG.length) ?? '';

const api: DesktopApi = {
  version,
  pickFolder: (options) => ipcRenderer.invoke('desktop:pick-folder', { title: options?.title, defaultPath: options?.defaultPath }),
  openFile: (exportFile) => ipcRenderer.invoke('desktop:open-file', String(exportFile)),
  showInFolder: (exportFile) => ipcRenderer.invoke('desktop:show-in-folder', String(exportFile)),
};

contextBridge.exposeInMainWorld('desktop', api);
