import { existsSync, statSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { editKey, isIdentityEdit, parseEdit, type PhotoEdit } from '../core';
import { infoFor, readFolderInfo, type FolderInfo, type PhotoInfoOptions } from '../../shared/photoinfo';
import type { Store } from './db';
import { expandHome } from './folders';
import { renderEdited } from '../../shared/server/photoEditRender';
import { analyze, existingThumb, fileStat, hashFile, isSupported, makeThumbnails, orientedSize, readMetadata, workingFile } from '../../shared/server/media';

// Background import jobs. The HTTP request returns immediately with a job id; the UI polls progress
// and sees photos appear as they finish. A bounded worker pool keeps memory flat for large folders.

export interface ImportJob {
  id: string;
  projectId: string;
  /** 'import' reads one folder; 'sync' re-reads the project's linked folders. */
  kind: 'import' | 'sync' | 'paths';
  folder: string;
  folders: string[];
  status: 'scanning' | 'running' | 'done' | 'failed';
  total: number;
  processed: number;
  imported: number;
  alreadyInLibrary: number;
  exactDuplicates: number;
  /** Photos found at a new path (moved or renamed): same photo, nothing re-imported. */
  moved: number;
  /** Photos whose file left a linked folder and that aren't on any page: taken out of the library. */
  removed: number;
  /** Linked folders that weren't there (renamed, deleted, or on a drive that isn't plugged in). */
  missingFolders: string[];
  failed: number;
  /** 'paths' jobs: the asset id for each input in order ('' for a file that failed); a folder input gives one entry per photo in it. */
  assetIds: string[];
  /** 'paths' jobs: for each `assetIds` entry, the dropped folder it came from ('' for a dropped file). */
  assetFolders?: string[];
  errors: { file: string; error: string }[];
  startedAt: string;
  finishedAt?: string;
}

const CONCURRENCY = 4;

export async function scanFolder(folder: string, recursive: boolean): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory() && recursive) await walk(p);
      else if (e.isFile() && isSupported(p)) out.push(p);
    }
  };
  await walk(folder);
  return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export const resolveFolder = (input: string) => resolve(expandHome(input));

/** Whether `path` is inside `folder` (or is it). */
export const isInside = (path: string, folder: string) => path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);

export class Importer {
  private jobs = new Map<string, ImportJob>();
  /** One job at a time per project, so an import and a sync never catalogue the same file twice. */
  private queues = new Map<string, Promise<void>>();
  private syncing = new Map<string, ImportJob>();

  /** Each job reads a folder's photoinfo.json once. */
  private infoCache = new WeakMap<ImportJob, Map<string, FolderInfo>>();

  /** `photoInfo` is where photoinfo.json is read from; leave it out and saved edits are not applied. */
  constructor(private store: Store, private photoInfo?: PhotoInfoOptions) {}

  /** The edit saved for this photo in its folder's photoinfo.json, or null (an identity edit counts as none). */
  private editFor(job: ImportJob, path: string): PhotoEdit | null {
    if (!this.photoInfo) return null;
    let folders = this.infoCache.get(job);
    if (!folders) this.infoCache.set(job, (folders = new Map()));
    const folder = dirname(path);
    let info = folders.get(folder);
    if (!info) folders.set(folder, (info = readFolderInfo(folder, this.photoInfo)));
    const edit = parseEdit(infoFor(info, basename(path))?.edit);
    return edit && !isIdentityEdit(edit) ? edit : null;
  }

  get(id: string) {
    return this.jobs.get(id);
  }

  start(projectId: string, folderInput: string, recursive = true): ImportJob {
    const folder = resolveFolder(folderInput);
    const job = this.newJob(projectId, 'import', [folder]);
    this.enqueue(job, () => this.run(job, recursive));
    return job;
  }

  /**
   * Import individual files (dropped from the file manager). A folder among them is scanned like
   * `start` does. `assetIds` lists the asset for each file in input order, '' for one that failed.
   */
  startPaths(projectId: string, paths: string[]): ImportJob {
    const inputs = paths.map(resolveFolder);
    const job = this.newJob(projectId, 'paths', []);
    job.folder = inputs.length === 1 ? inputs[0] : `${inputs.length} dropped items`;
    this.enqueue(job, () => this.runPaths(job, inputs));
    return job;
  }

  /**
   * Re-read the project's linked folders: add new photos, follow moved ones, and drop photos whose
   * file is gone — unless they're on a page (`inUse`), where they stay and show as missing.
   * A sync already queued or running for the project is returned instead of starting another.
   */
  sync(projectId: string, folders: string[], inUse: Set<string>): ImportJob {
    const pending = this.syncing.get(projectId);
    if (pending && pending.status !== 'done' && pending.status !== 'failed') return pending;
    const job = this.newJob(projectId, 'sync', folders);
    this.syncing.set(projectId, job);
    this.enqueue(job, async () => {
      job.missingFolders = folders.filter((f) => !existsSync(f));
      await this.run(job, true, () => {
        for (const f of folders) if (!job.missingFolders.includes(f)) this.store.markLinkSynced(projectId, f);
        this.dropGone(job, inUse);
      });
    });
    return job;
  }

  private newJob(projectId: string, kind: ImportJob['kind'], folders: string[]): ImportJob {
    const job: ImportJob = {
      id: randomUUID(), projectId, kind, folder: folders.length === 1 ? folders[0] : `${folders.length} linked folders`, folders,
      status: 'scanning', total: 0, processed: 0, imported: 0, alreadyInLibrary: 0, exactDuplicates: 0, moved: 0, removed: 0,
      missingFolders: [], failed: 0, assetIds: [], errors: [], startedAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    return job;
  }

  private enqueue(job: ImportJob, work: () => Promise<void>) {
    const next = (this.queues.get(job.projectId) ?? Promise.resolve()).then(work, work);
    this.queues.set(job.projectId, next.catch(() => undefined));
  }

  /** Resolves when the job finishes (used by tests and scripts). */
  async wait(id: string): Promise<ImportJob> {
    for (;;) {
      const job = this.jobs.get(id)!;
      if (job.status === 'done' || job.status === 'failed') return job;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** `finish` runs after every file is read, before the job reports done. */
  private async run(job: ImportJob, recursive: boolean, finish?: () => void) {
    try {
      const files: string[] = [];
      for (const folder of job.folders) {
        if (!existsSync(folder)) {
          if (job.kind === 'sync') continue;
          throw new Error(`Folder not found: ${folder}`);
        }
        files.push(...(await scanFolder(folder, recursive)));
      }
      job.total = files.length;
      job.status = 'running';
      let next = 0;
      const worker = async () => {
        while (next < files.length) {
          const file = files[next++];
          try {
            await this.importOne(job, file);
          } catch (e) {
            job.failed++;
            job.errors.push({ file: basename(file), error: e instanceof Error ? e.message : String(e) });
          }
          job.processed++;
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      finish?.();
      job.status = 'done';
    } catch (e) {
      job.status = 'failed';
      job.errors.push({ file: job.folder, error: e instanceof Error ? e.message : String(e) });
    }
    job.finishedAt = new Date().toISOString();
  }

  private async runPaths(job: ImportJob, inputs: string[]) {
    try {
      const files: string[] = [];
      /** For each entry of `files`: the dropped folder it was found in, '' for a dropped file. */
      const from: string[] = [];
      for (const input of inputs) {
        let isDir = false;
        try {
          isDir = statSync(input).isDirectory();
        } catch {
          job.failed++;
          job.errors.push({ file: basename(input), error: `${basename(input)}: not found` });
          files.push('');
          from.push('');
          continue;
        }
        if (isDir) {
          const found = await scanFolder(input, true);
          files.push(...found);
          from.push(...found.map(() => input));
        } else {
          files.push(input);
          from.push('');
        }
      }
      job.total = files.length;
      job.assetIds = files.map(() => '');
      job.assetFolders = from;
      job.status = 'running';
      let next = 0;
      const worker = async () => {
        while (next < files.length) {
          const at = next++;
          const file = files[at];
          if (!file) {
            job.processed++;
            continue;
          }
          try {
            if (!isSupported(file)) job.errors.push({ file: basename(file), error: `${basename(file)}: not a photo this app can read` });
            else job.assetIds[at] = await this.importOne(job, file);
          } catch (e) {
            job.failed++;
            job.errors.push({ file: basename(file), error: e instanceof Error ? e.message : String(e) });
          }
          job.processed++;
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      job.status = 'done';
    } catch (e) {
      job.status = 'failed';
      job.errors.push({ file: job.folder, error: e instanceof Error ? e.message : String(e) });
    }
    job.finishedAt = new Date().toISOString();
  }

  /** Catalogue one file and add it to the project; resolves to its asset id. */
  private async importOne(job: ImportJob, path: string): Promise<string> {
    const st = await fileStat(path);
    const existing = this.store.assetByPath(path);
    const dataDir = this.store.dataDir;
    const edit = this.editFor(job, path);
    const key = edit ? editKey(edit) : null;
    // The saved edit is part of "unchanged": the derived file must be the one this edit makes (or none, without an edit).
    const derivedName = existing?.derived_path ? basename(existing.derived_path) : '';
    const sameEdit = key ? derivedName.endsWith(`-edit-${key}.jpg`) && existsSync(existing!.derived_path!) : !derivedName.includes('-edit-');
    // Unchanged file already catalogued: just add it to this project.
    if (existing && existing.file_size === st.size && existing.mtime_ms === st.mtimeMs && sameEdit && existingThumb(dataDir, existing.id, 's')) {
      this.store.linkAsset(job.projectId, existing.id);
      job.alreadyInLibrary++;
      return existing.id;
    }
    const contentHash = await hashFile(path);
    if (!existing) {
      // The same photo whose old file is gone: it was moved or renamed. Follow it, keeping its place on pages.
      const moved = this.store.projectAssetsWithHash(job.projectId, contentHash).find((a) => !existsSync(a.original_path));
      if (moved) {
        this.store.relocateAsset(moved.id, path);
        job.moved++;
        return moved.id;
      }
    }
    const id = existing?.id ?? randomUUID();
    const work = await workingFile(path, dataDir, contentHash);
    let derived = work.derived;
    if (edit && key) {
      // Everything below reads the edited picture; the original stays untouched.
      derived = join(dataDir, 'derived', `${contentHash}-edit-${key}.jpg`);
      if (!existsSync(derived)) await renderEdited(work.path, edit, derived, 'jpeg', { keepMetadata: true });
    }
    const read = derived ?? work.path;
    const [size, meta, analysis] = await Promise.all([orientedSize(read), readMetadata(path), analyze(read)]);
    await makeThumbnails(read, dataDir, id, !!analysis.transparent);
    const dup = this.store.firstAssetWithHash(contentHash, id);
    this.store.tx(() => {
      this.store.upsertAsset({
        id,
        original_path: path,
        file_name: basename(path),
        format: extname(path).slice(1).toLowerCase() === 'jpg' ? 'jpeg' : extname(path).slice(1).toLowerCase(),
        file_size: st.size,
        mtime_ms: st.mtimeMs,
        content_hash: contentHash,
        width: size.width,
        height: size.height,
        captured_at: meta.capturedAt,
        gps_lat: meta.gpsLat,
        gps_lon: meta.gpsLon,
        rating: existing?.rating ?? 0,
        favorite: existing?.favorite ?? 0,
        tags: existing?.tags ?? '[]',
        analysis: JSON.stringify(analysis),
        derived_path: derived,
        exact_duplicate_of: dup?.id ?? null,
        imported_at: existing?.imported_at ?? new Date().toISOString(),
      });
      this.store.linkAsset(job.projectId, id);
    });
    // An earlier edit's file is of no use now.
    const old = existing?.derived_path;
    if (old && old !== derived && basename(old).includes('-edit-') && dirname(old) === join(dataDir, 'derived')) await rm(old, { force: true });
    if (dup) job.exactDuplicates++;
    job.imported++;
    return id;
  }

  private dropGone(job: ImportJob, inUse: Set<string>) {
    const folders = job.folders.filter((f) => !job.missingFolders.includes(f));
    this.store.tx(() => {
      for (const r of this.store.projectAssetRows(job.projectId)) {
        if (inUse.has(r.id) || !folders.some((f) => isInside(r.original_path, f)) || existsSync(r.original_path)) continue;
        this.store.unlinkAsset(job.projectId, r.id);
        job.removed++;
      }
    });
  }
}
