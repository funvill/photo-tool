// Photo Tool's steps of the acceptance test built into the app (the shared harness, the offline
// checks and result.json are in shared/electron). Run only with explicit flags:
//
//   "Photo Tool" --self-test <photo folder> --self-test-out <folder>
//
// It opens a copy of the folder (<folder>/photos: the photos given are never written), waits for it
// to be read, stars one photo in the viewer and checks the star in that copy's photoinfo.json. Then it
// checks that the photo-tagging worker loads its runtime (onnxruntime-node), with no model. Before
// all that, it checks this build decodes the newer formats and refuses SVG by path (mediaFormats).
import { cpSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { Worker } from 'node:worker_threads';
import { selfTestOverlap, taggingWorkerPath } from '../../shared/electron/config';
import type { WorkerPing, WorkerPong } from '../server/tagging/worker';
import { harness, offlineChecks, sleep, type SelfTestContext, type Step } from '../../shared/electron/selfTest';

/** Every file under `dir` (relative path → size and time changed): to show the photos given were left alone. */
function folderSnapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const path = join(e.parentPath, e.name);
    const s = statSync(path);
    out[relative(dir, path)] = `${s.size}:${s.mtimeMs}`;
  }
  return out;
}

/**
 * The folder Photo Tool's self-test opens: a fresh copy of the photos given, in <out>/photos, so
 * the star it sets (and photoinfo.json) lands in the copy and never beside the original photos.
 * Returns the copy and a snapshot of the original, for runGallerySelfTest to compare at the end.
 */
export function prepareGalleryPhotos(source: string, out: string): { folder: string; sourceBefore: Record<string, string> } {
  // Checked before anything is deleted or copied: <out>/photos could be the photos given.
  const overlap = selfTestOverlap(source, out);
  if (overlap) throw new Error(overlap);
  const folder = join(out, 'photos');
  rmSync(folder, { recursive: true, force: true });
  const sourceBefore = folderSnapshot(source);
  cpSync(source, folder, { recursive: true });
  return { folder, sourceBefore };
}

/**
 * Photo Tool, as a person would use it: the copy in `ctx.photos` is opened at start (main.ts hands
 * it to the page like a folder given on the command line), the scan is waited for, one photo is opened
 * in the viewer and starred with S, and the star must reach that photo's photoinfo.json.
 */
export async function runGallerySelfTest(ctx: SelfTestContext & { source: string; sourceBefore: Record<string, string> }): Promise<Record<string, Step>> {
  const h = harness(ctx);
  const { steps, step, js, api, waitFor, screenshot } = h;
  const key = (k: string) => js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true }))`);
  let starred = '';

  await step('health', async () => {
    const r = await api('GET', '/api/health');
    return { ok: r.ok === true && r.app === 'gallery', app: r.app };
  });

  // The formats #6 phase 2 added, decoded by this installed sharp build from tiny pictures made on the
  // spot (AVIF, TIFF, GIF, SVG, BMP, and a DNG's embedded preview from #6 phase 3), and SVG refused when loaded by path (sharp.block) and when
  // disguised under a photo's name. Here the block itself must hold too: a build without it (Linux's
  // wasm sharp, say) still refuses SVG by content, but CI should hear about it.
  await step('mediaFormats', async () => {
    const r = await api('GET', '/api/gallery/media-check');
    return { ...r, ok: r.ok === true && r.svgGuard?.pathRefused === true && r.svgGuard?.blockApplied === true };
  });

  await step('openFolder', async () => {
    // The open folder's path in the top bar (beside it, also .muted, is the version label).
    const probe = `({
      root: document.querySelector('.gallery-bar-title .gallery-root')?.textContent ?? null,
      scanning: !!document.querySelector('.gallery-progress'),
      tiles: document.querySelectorAll('.gallery-tile').length,
      thumbsLoaded: [...document.querySelectorAll('.gallery-tile img')].filter((i) => i.complete && i.naturalWidth > 0).length,
      errors: [...document.querySelectorAll('.toast-error')].map((t) => t.textContent),
    })`;
    type Dom = { root: string | null; scanning: boolean; tiles: number; thumbsLoaded: number; errors: string[] };
    const dom = await waitFor<Dom>(probe, (d) => d.root === ctx.photos && !d.scanning && d.tiles > 0 && d.thumbsLoaded >= d.tiles, 120_000);
    return { ok: dom.root === ctx.photos && !dom.scanning && dom.tiles > 0 && dom.thumbsLoaded >= dom.tiles && dom.errors.length === 0, ...dom, ...(await screenshot('gallery.png')) };
  });

  await step('starInViewer', async () => {
    // The first photo not starred yet (the folder given may have a photoinfo.json of its own).
    const path = await js<string | null>(`(() => {
      const tile = [...document.querySelectorAll('.gallery-tile')].find((t) => !t.classList.contains('starred'));
      if (!tile) return null;
      tile.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return tile.dataset.path;
    })()`);
    if (!path) throw new Error('Every photo shown is starred already: nothing to star.');
    const viewer = `({ open: !!document.querySelector('.gallery-viewer'), name: document.querySelector('.gallery-viewer-bar strong')?.textContent ?? null, count: document.querySelector('.gallery-viewer-count')?.textContent ?? null, starred: !!document.querySelector('.gallery-viewer-starred') })`;
    type Viewer = { open: boolean; name: string | null; count: string | null; starred: boolean };
    const opened = await waitFor<Viewer>(viewer, (v) => v.open && v.name === basename(path), 10_000);
    if (!opened.open) throw new Error('The viewer did not open on a double-click.');
    await key('s');
    const shown = await waitFor<Viewer>(viewer, (v) => v.starred, 10_000);
    // The page has saved it; the file must say so too.
    const file = join(dirname(path), 'photoinfo.json');
    const read = () => {
      try {
        return JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
    };
    const end = Date.now() + 10_000;
    let info = read();
    while (info?.photos?.[basename(path)]?.star !== true && Date.now() < end) {
      await sleep(250);
      info = read();
    }
    const shot = await screenshot('gallery-viewer.png');
    await key('Escape');
    const closed = await waitFor<{ open: boolean; tileStarred: boolean }>(
      `({ open: !!document.querySelector('.gallery-viewer'), tileStarred: !![...document.querySelectorAll('.gallery-tile')].find((t) => t.dataset.path === ${JSON.stringify(path)})?.classList.contains('starred') })`,
      (v) => !v.open && v.tileStarred,
      10_000,
    );
    starred = path;
    const entry = info?.photos?.[basename(path)];
    return {
      ok: opened.open && shown.starred && info?.format === 'photoinfo/1' && entry?.star === true && !closed.open && closed.tileStarred && dirname(file).startsWith(ctx.photos),
      photo: path, viewerCount: opened.count, photoInfoFile: file, entry, viewerClosed: !closed.open, tileStarred: closed.tileStarred, ...shot,
    };
  });

  await step('sourceUntouched', async () => {
    const after = folderSnapshot(ctx.source);
    const changed = [...new Set([...Object.keys(ctx.sourceBefore), ...Object.keys(after)])].filter((f) => ctx.sourceBefore[f] !== after[f]);
    return { ok: changed.length === 0 && !!starred, source: ctx.source, files: Object.keys(after).length, changed };
  });

  await step('taggingWorkerLoads', () => pingTaggingWorker(taggingWorkerPath(__dirname), 30_000));

  await offlineChecks(h, ctx);
  return steps;
}

/**
 * Photo tagging's runtime, without a model: starts the tagging worker the server would start (its unpacked copy
 * in the installed app) and asks it which onnxruntime-node it loaded. Its ping reads nothing and downloads nothing.
 */
export function pingTaggingWorker(workerFile: string, timeoutMs: number): Promise<{ ok: boolean; ort?: string; error?: string; workerFile: string }> {
  return new Promise((resolve) => {
    let worker: Worker;
    const done = (r: { ok: boolean; ort?: string; error?: string }) => {
      clearTimeout(timer);
      void worker?.terminate();
      resolve({ ...r, workerFile });
    };
    const timer = setTimeout(() => done({ ok: false, error: `The tagging worker did not answer within ${timeoutMs / 1000} s.` }), timeoutMs);
    try {
      worker = new Worker(workerFile);
    } catch (e) {
      done({ ok: false, error: String((e as Error)?.message ?? e) });
      return;
    }
    worker.on('message', (m: WorkerPong | unknown) => {
      if ((m as WorkerPong)?.type !== 'pong') return;
      const ort = (m as WorkerPong).ort;
      done({ ok: /^\d+\.\d+\.\d+/.test(ort), ort, ...(ort ? {} : { error: 'onnxruntime-node did not load.' }) });
    });
    worker.on('error', (e) => done({ ok: false, error: String((e as Error)?.stack ?? e) }));
    worker.on('exit', (code) => done({ ok: false, error: `The tagging worker stopped (code ${code}).` }));
    worker.postMessage({ type: 'ping' } satisfies WorkerPing);
  });
}
