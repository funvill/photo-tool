// A photo file's fingerprint for matching its tags on any computer: `fk1:<size>:<sha1 of its size, its first 16 KiB
// and its last 16 KiB>`. The size comes first so a lookup can rule out every entry of another size without reading. Unlike the content key (a hash of a thumbnail this computer's image library decoded and encoded, which can
// differ between sharp builds, CPUs and systems), it depends on the file's bytes only. It is the same for a copy under
// another name, folder or modified time, and changes when the file does (an edit, a metadata rewrite, another photo).
// Reads 32 KiB at most, never the whole file.
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export const FILE_KEY_VERSION = 'fk1';
const PART = 16 * 1024;

/** The file's key, or undefined when it can't be read. */
export function fileKeyOf(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const size = fstatSync(fd).size;
    const hash = createHash('sha1').update(`${size}\0`);
    const head = Buffer.alloc(Math.min(PART, size));
    readSync(fd, head, 0, head.length, 0);
    hash.update(head);
    if (size > PART) {
      const tail = Buffer.alloc(Math.min(PART, size - PART));
      readSync(fd, tail, 0, tail.length, size - tail.length);
      hash.update(tail);
    }
    return `${FILE_KEY_VERSION}:${size}:${hash.digest('hex')}`;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** The file size a key was made for, or undefined for a key in another shape. */
export function fileKeySize(key: string): number | undefined {
  const m = /^fk1:(\d+):/.exec(key);
  return m ? Number(m[1]) : undefined;
}
