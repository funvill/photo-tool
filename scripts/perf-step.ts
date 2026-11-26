// How long one step takes in Photo Tool's viewer and preview pane: from the arrow key going down to the
// next photo's large picture on screen (loaded, decoded, a frame drawn). Issue #5 measures each phase with it.
//
//   npx tsx scripts/perf-step.ts [--photos 300] [--steps 40] [--dwell 250] [--latency 0] [--port 5790] [--no-build]
//
// It makes a temp album of synthetic JPEGs (sharp, 2400 x 1600) and temp data folders, serves the built
// page from Photo Tool's own server on 127.0.0.1, and drives the system Chrome. Never touches photos/,
// data/ or %APPDATA%; every temp folder is removed at the end. Not part of the test suite.
//
// --dwell is the pause between steps in ms (250: someone looking at each photo; 0: as fast as each one
// shows). --latency adds that many ms to every request (Chrome's network emulation) to stand in for a
// slower disk or a busy server.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import sharp from 'sharp';
import { build } from 'vite';
import { createGalleryApp } from '../photo-tool/server/app';

function arg(name: string, fallback: number): number {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? Number(process.argv[at + 1]) : fallback;
}
const PHOTOS = arg('photos', 300);
const STEPS = arg('steps', 40);
const DWELL = arg('dwell', 250);
const LATENCY = arg('latency', 0);
const PORT = arg('port', 5790);

/** N photos of soft colour blobs (noise scaled up), each different, about the size of a phone photo. */
async function makeAlbum(dir: string, n: number): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const jobs: Promise<unknown>[] = [];
  for (let i = 0; i < n; i++) {
    const blobs = await sharp({ create: { width: 48, height: 32, channels: 3, background: '#000', noise: { type: 'gaussian', mean: 60 + ((i * 37) % 140), sigma: 60 } } }).png().toBuffer();
    jobs.push(sharp(blobs).resize(2400, 1600, { kernel: 'cubic' }).jpeg({ quality: 85 }).toFile(join(dir, `p${String(i).padStart(5, '0')}.jpg`)));
    if (jobs.length >= 8) await Promise.all(jobs.splice(0));
  }
  await Promise.all(jobs);
}

/** Keydown time, taken before the page's own handlers run (a window capture listener added first). */
const KEY_CLOCK = `window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') window.__keyAt = performance.now();
}, true);`;

/** Waits for `img` (a selector) to show a photo other than `before`, fully loaded, then one frame more; ms since the key went down. */
// Page code is sent as text: tsx would wrap a named inner function in a helper the page does not have.
function painted(page: Page, selector: string, before: string): Promise<{ swap: number; total: number }> {
  return page.evaluate(`new Promise((done) => {
    const check = () => {
      const img = document.querySelector(${JSON.stringify(selector)});
      if (img && img.alt !== ${JSON.stringify(before)} && img.complete && img.naturalWidth > 0) {
        // Decoded too (at once when it already is), then the frame that draws it.
        // swap: the page has put the new photo in (React's work); total: decoded and drawn too.
        const swap = performance.now() - window.__keyAt;
        img.decode().catch(() => {}).then(() => requestAnimationFrame(() => done({ swap, total: performance.now() - window.__keyAt })));
      } else requestAnimationFrame(check);
    };
    check();
  })`) as Promise<{ swap: number; total: number }>;
}

function summary(ms: number[]): string {
  const s = [...ms].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const slow = s.filter((t) => t > 16.7).length;
  return `median ${at(0.5).toFixed(1)} ms · p90 ${at(0.9).toFixed(1)} ms · max ${s[s.length - 1].toFixed(1)} ms · over one frame: ${slow}/${s.length}`;
}

async function run(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'photo-tool-perf-'));
  const album = join(root, 'album');
  let server: Server | null = null;
  let close = () => {};
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    if (!process.argv.includes('--no-build')) await build({ configFile: resolve('photo-tool/vite.config.ts'), logLevel: 'warn' });
    console.log(`Making ${PHOTOS} photos in ${album} …`);
    await makeAlbum(album, PHOTOS);
    const made = createGalleryApp(join(root, 'data'), { photoInfoFallbackDir: join(root, 'photoinfo'), staticDir: resolve('dist/photo-tool/web') });
    close = made.close;
    server = await new Promise<Server>((ok) => {
      const s = made.app.listen(PORT, '127.0.0.1', () => ok(s));
    });
    const base = `http://127.0.0.1:${PORT}`;
    const opened = await fetch(`${base}/api/gallery/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folder: album, recursive: false }) });
    if (opened.status !== 202) throw new Error(`open: ${opened.status}`);

    const results: string[] = [];
    for (const where of ['viewer', 'preview'] as const) {
      // A fresh browser each time: nothing cached from the run before.
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      if (LATENCY > 0) {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: LATENCY, downloadThroughput: -1, uploadThroughput: -1 });
      }
      await page.addInitScript(KEY_CLOCK);
      await page.goto(base);
      await page.getByRole('button', { name: album }).click();
      await page.locator('.gallery-tile').first().waitFor({ timeout: 120_000 });
      await page.getByRole('progressbar').waitFor({ state: 'detached', timeout: 300_000 });
      const selector = where === 'viewer' ? '.gallery-viewer-img' : '.gallery-preview-img';
      if (where === 'viewer') {
        await page.locator('.gallery-tile').first().dblclick();
      } else {
        await page.locator('.gallery-tile').first().click();
      }
      await page.waitForFunction(`(() => { const img = document.querySelector(${JSON.stringify(selector)}); return !!img && img.complete && img.naturalWidth > 0; })()`);
      // Someone opening a photo looks at it for a moment before the first step.
      await page.waitForTimeout(1000);
      const times: number[] = [];
      const swaps: number[] = [];
      for (let i = 0; i < STEPS; i++) {
        const before = (await page.locator(selector).getAttribute('alt')) ?? '';
        const wait = painted(page, selector, before);
        await page.keyboard.press('ArrowRight');
        const t = await wait;
        times.push(t.total);
        swaps.push(t.swap);
        if (DWELL > 0) await page.waitForTimeout(DWELL);
      }
      results.push(`${where.padEnd(7)}  ${summary(times)}`);
      const s = [...swaps].sort((a, b) => a - b);
      results.push(`${''.padEnd(7)}  new photo put in after: median ${s[Math.floor(s.length / 2)].toFixed(1)} ms`);
      await context.close();
    }
    console.log(`\n${PHOTOS} photos, ${STEPS} steps, dwell ${DWELL} ms, latency ${LATENCY} ms`);
    for (const line of results) console.log(line);
  } finally {
    await browser.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    close();
    rmSync(root, { recursive: true, force: true });
  }
}

await run();
