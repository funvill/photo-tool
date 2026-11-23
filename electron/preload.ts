// The only bridge between the page and the desktop app: a few functions on `window.desktop`.
// The page stays an ordinary sandboxed web page (no Node, context-isolated).
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopApi } from '../src/shared/desktopApi';

const VERSION_FLAG = '--photobook-version=';
const version = process.argv.find((a) => a.startsWith(VERSION_FLAG))?.slice(VERSION_FLAG.length) ?? '';

const api: DesktopApi = {
  version,
  pickFolder: (options) => ipcRenderer.invoke('desktop:pick-folder', { title: options?.title, defaultPath: options?.defaultPath }),
  // A dropped file's real path (File.path is gone in current Electron). Empty for a file with no path on disk.
  pathForFile: (file) => webUtils.getPathForFile(file),
  openFile: (exportFile) => ipcRenderer.invoke('desktop:open-file', String(exportFile)),
  showInFolder: (exportFile) => ipcRenderer.invoke('desktop:show-in-folder', String(exportFile)),
};

contextBridge.exposeInMainWorld('desktop', api);
