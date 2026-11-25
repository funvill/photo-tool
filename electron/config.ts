// The temporary `--gallery` switch: until the two programs are built apart, the one desktop build is
// the editor, or with `--gallery` Photo Tool. Everything both programs share is in shared/electron/config.ts.
// Unit-tested in tests/electron-shell.test.ts.

/** The same build runs two programs: the editor, and with `--gallery` Photo Tool. */
export type AppMode = 'editor' | 'gallery';

/** Photo Tool's own name: its own data, Chromium profile and single-instance lock. */
export const GALLERY_PRODUCT_NAME = 'Photo Tool';

/**
 * Photo Tool's Windows AppUserModelID (its appId), so the taskbar keeps its windows apart from the
 * editor's. electron/installer.nsh gives the Photo Tool shortcuts the same one (tests/electron-shell.test.ts checks).
 */
export const GALLERY_APP_ID = 'app.phototool.desktop';

/** `--gallery [folder]` starts Photo Tool (opening that folder); anything else, the editor. */
export function parseMode(argv: readonly string[]): { mode: AppMode; folder: string | null } {
  const i = argv.indexOf('--gallery');
  if (i < 0) return { mode: 'editor', folder: null };
  const v = argv[i + 1];
  return { mode: 'gallery', folder: v && !v.startsWith('--') ? v : null };
}

/**
 * How the editor starts Photo Tool: this same program with `--gallery`. From source that is
 * electron with the app folder. Run as an AppImage, execPath is the binary inside the editor's own
 * FUSE mount, which goes away when the editor quits, so the AppImage file itself ($APPIMAGE) is run.
 */
export function galleryLaunchCommand(o: { execPath: string; packaged: boolean; appPath: string; env: Record<string, string | undefined> }): { command: string; args: string[] } {
  if (o.env.APPIMAGE) return { command: o.env.APPIMAGE, args: ['--gallery'] };
  return { command: o.execPath, args: [...(o.packaged ? [] : [o.appPath]), '--gallery'] };
}
