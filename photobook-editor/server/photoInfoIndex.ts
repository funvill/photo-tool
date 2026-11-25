// Per-folder photoinfo.json, cached and re-read when the file changes, applied to the library's photos.
import { statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { PhotoAsset } from '../core';
import { folderStamp, infoFor, readFolderInfo, updatePhotoInfo, type FolderInfo, type PhotoInfoOptions } from '../../shared/photoinfo';

/** File-system access the index uses; replaceable so tests can count reads. */
export interface PhotoInfoIo {
  stamp: (folder: string, opts: PhotoInfoOptions) => string;
  read: (folder: string, opts: PhotoInfoOptions) => FolderInfo;
  isFolder: (folder: string) => boolean;
}

const isFolder = (folder: string): boolean => {
  try {
    return statSync(folder).isDirectory();
  } catch {
    return false;
  }
};

const DEFAULT_IO: PhotoInfoIo = { stamp: folderStamp, read: readFolderInfo, isFolder };

/** A folder's info as resolved for one listing. `unavailable`: the folder or its file could not be read. */
interface Resolved {
  info: FolderInfo;
  unavailable: boolean;
}

export class PhotoInfoIndex {
  private cache = new Map<string, { stamp: string; info: FolderInfo }>();
  private io: PhotoInfoIo;

  constructor(private opts: PhotoInfoOptions, io: Partial<PhotoInfoIo> = {}) {
    this.io = { ...DEFAULT_IO, ...io };
  }

  private resolve(folder: string): Resolved {
    if (!this.io.isFolder(folder)) return { info: { photos: {}, source: 'none', stamp: 'none' }, unavailable: true };
    const stamp = this.io.stamp(folder, this.opts);
    const hit = this.cache.get(folder);
    let info: FolderInfo;
    if (hit && hit.stamp === stamp) info = hit.info;
    else {
      info = this.io.read(folder, this.opts);
      this.cache.set(folder, { stamp, info });
    }
    return { info, unavailable: !!info.error };
  }

  /**
   * The photos as their folders' files describe them: star, date, place, people and description win over what
   * the library stored. Each distinct folder is looked at once per call. A photo whose folder is unreachable or
   * whose photoinfo.json can't be read is marked `infoUnavailable` (its star is unknown, not "off").
   */
  applyAll(rows: { asset: PhotoAsset; path: string }[]): PhotoAsset[] {
    const folders = new Map<string, Resolved>();
    return rows.map(({ asset, path }) => {
      const folder = dirname(path);
      let resolved = folders.get(folder);
      if (!resolved) folders.set(folder, (resolved = this.resolve(folder)));
      return applyInfo(asset, resolved, basename(path));
    });
  }

  apply(asset: PhotoAsset, originalPath: string): PhotoAsset {
    return this.applyAll([{ asset, path: originalPath }])[0];
  }

  /** Throws PhotoInfoWriteError when the folder's file can't be read or written. */
  setStar(originalPath: string, star: boolean): void {
    const folder = dirname(originalPath);
    updatePhotoInfo(folder, basename(originalPath), { star: star ? true : null }, this.opts);
    this.cache.delete(folder);
  }

  /** Joined stamps of the given photos' folders; changes when any folder's file changes. */
  stampFor(paths: string[]): string {
    const folders = [...new Set(paths.map((p) => dirname(p)))].sort();
    return folders.map((f) => `${f}=${this.io.stamp(f, this.opts)}`).join('|');
  }
}

function applyInfo(asset: PhotoAsset, { info: folderInfo, unavailable }: Resolved, fileName: string): PhotoAsset {
  const info = infoFor(folderInfo, fileName);
  const out: PhotoAsset = { ...asset, favorite: info?.star === true };
  if (unavailable) out.infoUnavailable = true;
  else delete out.infoUnavailable;
  if (typeof info?.date === 'string') out.capturedAt = info.date;
  const loc = info?.location;
  if (loc && typeof loc.lat === 'number' && typeof loc.lon === 'number') {
    out.gpsLat = loc.lat;
    out.gpsLon = loc.lon;
  }
  if (Array.isArray(info?.people)) out.people = info.people.filter((p): p is string => typeof p === 'string');
  if (typeof info?.description === 'string') out.description = info.description;
  return out;
}
