import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import nodePath from 'node:path';

// Paths typed or clicked in the folder browser. The platform is a parameter so both sets of rules
// can be tested anywhere.

/** On Windows, the folder browser's top level: the list of drives. */
export const DRIVES = '/';
/** What the path box shows there: it is a place to pick a drive from, not a folder. */
export const DRIVES_LABEL = 'This PC';

/** `~`, `~/x` and `~\x` mean the home folder. */
export const expandHome = (input: string, home = homedir()) => input.replace(/^~(?=$|[\\/])/, () => home);

/**
 * The folder a folder-browser path points at: the home folder when empty, `~` expanded, made
 * absolute. On Windows a bare `/` or `\`, or its label typed back ("This PC"), is the list of
 * drives (returned as DRIVES), and a drive picked from that list arrives as `//C:` (the editor
 * joins folder names with `/`). UNC paths (`\\server\share\folder`) pass through.
 */
export function browsePath(raw: string, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  const input = expandHome(raw.trim() || home, home);
  if (platform !== 'win32') return nodePath.posix.resolve(input);
  if (/^[\\/]+$/.test(input) || input.toLowerCase() === DRIVES_LABEL.toLowerCase()) return DRIVES;
  const drive = input.replace(/^[\\/]+(?=[A-Za-z]:)/, '');
  return nodePath.win32.resolve(/^[A-Za-z]:$/.test(drive) ? `${drive}\\` : drive);
}

/** The folder above, or null at the top. On Windows the top is the list of drives, above every drive and share. */
export function browseParent(path: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'win32') return nodePath.posix.dirname(path) === path ? null : nodePath.posix.dirname(path);
  if (path === DRIVES) return null;
  return nodePath.win32.dirname(path) === path ? DRIVES : nodePath.win32.dirname(path);
}

/** The drive letters in use (Windows), as `C:`. */
export async function listDrives(): Promise<string[]> {
  const letters = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((l) => `${l}:`);
  const found = await Promise.all(letters.map((d) => access(`${d}\\`).then(() => true, () => false)));
  return letters.filter((_, i) => found[i]);
}
