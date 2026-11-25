// The only bridge between the editor's page and the desktop app: a few functions on `window.desktop`.
// The page stays an ordinary sandboxed web page (no Node, context-isolated). Only what the editor's
// page uses is here: Photo Tool's "Gallery window" functions are Photo Tool's.
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopApi } from '../../shared/desktop/desktopApi';

const VERSION_FLAG = '--photobook-version=';
const version = process.argv.find((a) => a.startsWith(VERSION_FLAG))?.slice(VERSION_FLAG.length) ?? '';

/** The editor's part of the desktop API. */
type EditorDesktopApi = Pick<DesktopApi, 'version' | 'pickFolder' | 'pathForFile' | 'openFile' | 'showInFolder'> & Partial<DesktopApi>;

const api: EditorDesktopApi = {
  version,
  pickFolder: (options) => ipcRenderer.invoke('desktop:pick-folder', { title: options?.title, defaultPath: options?.defaultPath }),
  // A dropped file's real path (File.path is gone in current Electron). Empty for a file with no path on disk.
  pathForFile: (file) => webUtils.getPathForFile(file),
  openFile: (exportFile) => ipcRenderer.invoke('desktop:open-file', String(exportFile)),
  showInFolder: (exportFile) => ipcRenderer.invoke('desktop:show-in-folder', String(exportFile)),
};

contextBridge.exposeInMainWorld('desktop', api);
