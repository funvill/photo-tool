// What the desktop app (Electron) adds to the page as `window.desktop`. It is missing in a plain
// browser, so every use is feature-detected: `desktop?.pickFolder`. Types only; no code here.

export interface DesktopApi {
  /** The installed app's version, e.g. "0.1.0". */
  version: string;
  /** The system's "choose a folder" dialog. Resolves to the folder's path, or null when cancelled. */
  pickFolder(options?: { title?: string; defaultPath?: string }): Promise<string | null>;
  /** The path on disk of a file dropped onto the page (empty when it has none). */
  pathForFile(file: File): string;
  /** Open an exported file (by its file name) with the system's default app. False when it is not an export. */
  openFile(exportFile: string): Promise<boolean>;
  /** Show an exported file (by its file name) in the system's file manager. False when it is not an export. */
  showInFolder(exportFile: string): Promise<boolean>;
  /** Editor window: start the gallery program (or bring it forward when it is already running). */
  openGallery(): Promise<void>;
  /** Gallery window: drag these photo files out of the window, as files, into another program. */
  startDrag(paths: string[]): void;
  /**
   * Gallery window: the mouse button went down on a tile that would drag these files. They are
   * checked now, so that a drag that follows (startDrag with the same list) starts at once.
   */
  prepareDrag?(paths: string[]): void;
  /** Gallery window: `cb` gets the message when a drag could not start. Returns a function that stops listening. */
  onDragFailed?(cb: (message: string) => void): () => void;
  /**
   * Gallery window: `cb` gets each folder the gallery is asked to open from outside the page
   * (`--gallery <folder>` at start, or from a second launch). Returns a function that stops listening.
   */
  onOpenFolder?(cb: (folder: string) => void): () => void;
  /** Gallery window: put text (Copy path) on the clipboard; the page's own clipboard is not allowed in the app. */
  copyText?(text: string): Promise<{ ok: boolean; error?: string }>;
  /** Gallery window: put this photo on the clipboard as a picture, at full size. */
  copyImage?(path: string): Promise<{ ok: boolean; error?: string }>;
  /**
   * Gallery window: open the photo's folder in the file manager with the photo selected. (Named apart
   * from `showInFolder`, which shows an editor export by its file name.)
   */
  showPhotoInFolder?(path: string): Promise<{ ok: boolean; error?: string }>;
  /**
   * Gallery window: move these photos to the Recycle Bin (Trash) after a native confirm. Only photos of
   * the folder open now; `cancelled` when the person said no (nothing was moved).
   */
  trashPhotos?(paths: string[]): Promise<{ trashed: string[]; failed: { path: string; message: string }[]; cancelled: boolean }>;
  /**
   * Gallery window: the answer to the Map tab's "Load maps from the internet?" (null: not asked yet).
   * Kept by the desktop app, whose request guard lets map tiles through only while it is true.
   */
  getMapConsent?(): Promise<boolean | null>;
  /** Gallery window: remember the Map tab's answer; tiles may load from now on (true) or no longer (false). */
  setMapConsent?(on: boolean): Promise<void>;
}
