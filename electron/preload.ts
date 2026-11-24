// The only bridge between the page and the desktop app: a few functions on `window.desktop`.
// The page stays an ordinary sandboxed web page (no Node, context-isolated).
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopApi } from '../src/shared/desktopApi';

const VERSION_FLAG = '--photobook-version=';
const version = process.argv.find((a) => a.startsWith(VERSION_FLAG))?.slice(VERSION_FLAG.length) ?? '';

/** The page's onOpenFolder listeners still subscribed. */
let folderListeners = 0;

const api: DesktopApi = {
  version,
  pickFolder: (options) => ipcRenderer.invoke('desktop:pick-folder', { title: options?.title, defaultPath: options?.defaultPath }),
  // A dropped file's real path (File.path is gone in current Electron). Empty for a file with no path on disk.
  pathForFile: (file) => webUtils.getPathForFile(file),
  openFile: (exportFile) => ipcRenderer.invoke('desktop:open-file', String(exportFile)),
  showInFolder: (exportFile) => ipcRenderer.invoke('desktop:show-in-folder', String(exportFile)),
  openGallery: () => ipcRenderer.invoke('desktop:open-gallery'),
  startDrag: (paths) => ipcRenderer.send('gallery:start-drag', Array.isArray(paths) ? paths.map(String) : []),
  prepareDrag: (paths) => ipcRenderer.send('gallery:prepare-drag', Array.isArray(paths) ? paths.map(String) : []),
  onDragFailed: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, message: unknown) => cb(typeof message === 'string' ? message : "Couldn't drag the photos.");
    ipcRenderer.on('gallery:drag-failed', listener);
    return () => void ipcRenderer.removeListener('gallery:drag-failed', listener);
  },
  copyText: (text) => ipcRenderer.invoke('gallery:copy-text', String(text)),
  copyImage: (path) => ipcRenderer.invoke('gallery:copy-image', String(path)),
  showPhotoInFolder: (path) => ipcRenderer.invoke('gallery:show-in-folder', String(path)),
  trashPhotos: (paths) => ipcRenderer.invoke('gallery:trash', Array.isArray(paths) ? paths.map(String) : []),
  getMapConsent: () => ipcRenderer.invoke('gallery:get-map-consent'),
  setMapConsent: (on) => ipcRenderer.invoke('gallery:set-map-consent', on === true),
  getEditTarget: () => ipcRenderer.invoke('gallery:get-edit-target'),
  setEditTarget: (target) => ipcRenderer.invoke('gallery:set-edit-target', target === 'file' ? 'file' : 'info'),
  saveEditToFile: (path, edit) => ipcRenderer.invoke('gallery:save-edit-file', String(path), edit),
  saveEditAs: (path, edit, info) => ipcRenderer.invoke('gallery:save-edit-as', String(path), edit, info),
  setUnsavedEdits: (count) => ipcRenderer.send('gallery:unsaved-edits', Number(count) || 0),
  onOpenFolder: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, folder: unknown) => {
      if (typeof folder === 'string') cb(folder);
    };
    ipcRenderer.on('gallery:open-folder', listener);
    folderListeners++;
    // Now that someone listens, the main process hands over a folder it was given before the page was ready.
    ipcRenderer.send('gallery:ready-for-folders');
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      ipcRenderer.removeListener('gallery:open-folder', listener);
      // Nobody listens any more: the main process keeps the next folder until someone does.
      if (--folderListeners === 0) ipcRenderer.send('gallery:not-ready-for-folders');
    };
  },
};

contextBridge.exposeInMainWorld('desktop', api);
