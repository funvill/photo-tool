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
}
