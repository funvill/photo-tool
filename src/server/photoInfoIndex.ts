// Per-folder photoinfo.json, cached and re-read when the file changes, applied to the library's photos.
import { basename, dirname } from 'node:path';
import type { PhotoAsset } from '../core';
import { folderStamp, infoFor, readFolderInfo, updatePhotoInfo, type FolderInfo, type PhotoInfoOptions } from '../photoinfo';

export class PhotoInfoIndex {
  private cache = new Map<string, { stamp: string; info: FolderInfo }>();

  constructor(private opts: PhotoInfoOptions) {}

  private folderInfo(folder: string): FolderInfo {
    const stamp = folderStamp(folder, this.opts);
    const hit = this.cache.get(folder);
    if (hit && hit.stamp === stamp) return hit.info;
    const info = readFolderInfo(folder, this.opts);
    this.cache.set(folder, { stamp, info });
    return info;
  }

  /** The photo as the file describes it: star, date, place, people and description win over what the library stored. */
  apply(asset: PhotoAsset, originalPath: string): PhotoAsset {
    const info = infoFor(this.folderInfo(dirname(originalPath)), basename(originalPath));
    const out: PhotoAsset = { ...asset, favorite: info?.star === true };
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

  /** Throws PhotoInfoWriteError when the folder's file can't be read or written. */
  setStar(originalPath: string, star: boolean): void {
    const folder = dirname(originalPath);
    updatePhotoInfo(folder, basename(originalPath), { star: star ? true : null }, this.opts);
    this.cache.delete(folder);
  }

  /** Joined stamps of the given photos' folders; changes when any folder's file changes. */
  stampFor(paths: string[]): string {
    const folders = [...new Set(paths.map((p) => dirname(p)))].sort();
    return folders.map((f) => `${f}=${folderStamp(f, this.opts)}`).join('|');
  }
}
