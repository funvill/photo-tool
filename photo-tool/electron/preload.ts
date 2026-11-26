// The only bridge between Photo Tool's page and the desktop app: a few functions on `window.desktop`.
// The page stays an ordinary sandboxed web page (no Node, context-isolated). Only what Photo Tool's
// page uses is here: the editor's export functions are the editor's.
import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from '../../shared/desktop/desktopApi';

const VERSION_FLAG = '--photobook-version=';
const version = process.argv.find((a) => a.startsWith(VERSION_FLAG))?.slice(VERSION_FLAG.length) ?? '';

/** The page's onOpenFolder listeners still subscribed. */
let folderListeners = 0;

/** Photo Tool's part of the desktop API. */
type PhotoToolDesktopApi = Pick<DesktopApi, 'version' | 'pickFolder' | 'startDrag'> & Partial<DesktopApi>;

const api: PhotoToolDesktopApi = {
  version,
  pickFolder: (options) => ipcRenderer.invoke('desktop:pick-folder', { title: options?.title, defaultPath: options?.defaultPath }),
  startDrag: (paths) => ipcRenderer.send('gallery:start-drag', Array.isArray(paths) ? paths.map(String) : []),
  prepareDrag: (paths) => ipcRenderer.send('gallery:prepare-drag', Array.isArray(paths) ? paths.map(String) : []),
  onDragFailed: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, message: unknown) => cb(typeof message === 'string' ? message : "Couldn't drag the photos.");
    ipcRenderer.on('gallery:drag-failed', listener);
    return () => void ipcRenderer.removeListener('gallery:drag-failed', listener);
  },
  copyText: (text) => ipcRenderer.invoke('gallery:copy-text', String(text)),
  copyImage: (path) => ipcRenderer.invoke('gallery:copy-image', String(path)),
  copyFiles: (paths) => ipcRenderer.invoke('gallery:copy-files', Array.isArray(paths) ? paths.map(String) : []),
  showPhotoInFolder: (path) => ipcRenderer.invoke('gallery:show-in-folder', String(path)),
  trashPhotos: (paths) => ipcRenderer.invoke('gallery:trash', Array.isArray(paths) ? paths.map(String) : []),
  getMapConsent: () => ipcRenderer.invoke('gallery:get-map-consent'),
  setMapConsent: (on) => ipcRenderer.invoke('gallery:set-map-consent', on === true),
  getEditTarget: () => ipcRenderer.invoke('gallery:get-edit-target'),
  setEditTarget: (target) => ipcRenderer.invoke('gallery:set-edit-target', target === 'file' ? 'file' : 'info'),
  saveEditToFile: (path, edit) => ipcRenderer.invoke('gallery:save-edit-file', String(path), edit),
  saveEditAs: (path, edit, info) => ipcRenderer.invoke('gallery:save-edit-as', String(path), edit, info),
  onShowShortcuts: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('gallery:show-shortcuts', listener);
    return () => void ipcRenderer.removeListener('gallery:show-shortcuts', listener);
  },
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
