// The acceptance test built into the app, run only with explicit flags:
//
//   "Photobook Studio.exe" --self-test <photo folder> --self-test-out <folder>
//
// It does what a person would: makes a book, imports the folder, drafts it, exports the PDFs, a
// poster image and the flipbook, and looks at the home page and the editor in the real window. main.ts adds what it saw (console
// messages, failed loads, requests the offline filter cancelled) and writes <folder>/result.json.
import type { BrowserWindow, Session } from 'electron';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Step {
  ok: boolean;
  ms?: number;
  error?: string;
  [key: string]: unknown;
}

export interface SelfTestContext {
  /** The local server, e.g. http://127.0.0.1:51234 */
  base: string;
  photos: string;
  out: string;
  win: BrowserWindow;
  session: Session;
  log: (...a: unknown[]) => void;
}

const PAGES = 20;
const TITLE = 'Self-test book';
// Blurb's Large Square trims to 11.75 in (see scripts/draft-from-folder.ts).
const BLURB_LARGE_SQUARE_TRIM_MM = 11.75 * 25.4;
const sleep = (ms: number) => new Promise((d) => setTimeout(d, ms));

export async function runSelfTest(ctx: SelfTestContext): Promise<Record<string, Step>> {
  const steps: Record<string, Step> = {};
  const { base, win, log } = ctx;
  const js = <T = any>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true);

  async function step(name: string, fn: () => Promise<Omit<Step, 'ok'> & { ok?: boolean }>) {
    const t = Date.now();
    try {
      const r = await fn();
      steps[name] = { ...r, ok: r.ok !== false, ms: Date.now() - t };
    } catch (e) {
      steps[name] = { ok: false, ms: Date.now() - t, error: String((e as Error)?.stack ?? e) };
    }
    log('self-test', name, steps[name]);
    return steps[name].ok;
  }

  async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const json = (await res.json()) as T;
    if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${JSON.stringify(json)}`);
    return json;
  }

  async function waitFor<T>(code: string, good: (v: T) => boolean, timeoutMs: number): Promise<T> {
    const end = Date.now() + timeoutMs;
    let v = await js<T>(code);
    while (!good(v) && Date.now() < end) {
      await sleep(500);
      v = await js<T>(code);
    }
    return v;
  }

  async function screenshot(name: string) {
    let img = await win.webContents.capturePage();
    if (img.isEmpty()) {
      win.showInactive();
      await sleep(1000);
      img = await win.webContents.capturePage();
    }
    const file = join(ctx.out, name);
    writeFileSync(file, img.toPNG());
    return { screenshot: file, screenshotBytes: statSync(file).size, screenshotSize: img.getSize() };
  }

  /**
   * Decode an image the app serves (or a data: URI from a flipbook) in the page, and measure it:
   * its size and how much its pixels vary. A blank or one-colour picture has a spread near 0.
   */
  const measure = (src: string) =>
    js<{ width: number; height: number; spread: number; type: string }>(`(async () => {
      const src = ${JSON.stringify(src)};
      let blob;
      if (src.startsWith('data:')) {
        const [head, b64] = src.split(',');
        blob = new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: head.slice(5).split(';')[0] });
      } else {
        const res = await fetch(src);
        if (!res.ok) throw new Error(src + ' answered ' + res.status);
        blob = await res.blob();
      }
      const bmp = await createImageBitmap(blob);
      const w = Math.min(256, bmp.width), h = Math.min(256, bmp.height);
      const ctx = new OffscreenCanvas(w, h).getContext('2d');
      ctx.drawImage(bmp, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      let sum = 0, sq = 0;
      for (let i = 0; i < d.length; i += 4) { const v = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += v; sq += v * v; }
      const n = d.length / 4;
      return { width: bmp.width, height: bmp.height, spread: Math.round(Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2)) * 10) / 10, type: blob.type };
    })()`);
  const isHeic = (a: { fileName: string }) => /\.hei[cf]$/i.test(a.fileName);
  const waitForJob = async (job: any) => {
    let s = job;
    while (s.status !== 'done' && s.status !== 'failed') {
      await sleep(250);
      s = await api('GET', `/api/jobs/${job.id}`);
    }
    return s;
  };

  let projectId = '';
  let revision = 0;
  let exportFile = '';

  await step('health', async () => {
    const h = await api('GET', '/api/health');
    return { ok: h.ok === true, dataDir: h.dataDir, apiVersion: h.apiVersion };
  });

  await step('createBook', async () => {
    const created = await api('POST', '/api/projects', { title: TITLE, printerId: 'blurb', bindingId: 'hardcover', sizeId: 'blurb-sq12', stylePresetId: 'collage', pages: PAGES });
    projectId = created.doc.id;
    revision = created.revision;
    return { projectId };
  });

  await step('import', async () => {
    const s = await waitForJob(await api('POST', `/api/projects/${projectId}/import`, { folder: ctx.photos }));
    return { ok: s.status === 'done' && s.imported > 0 && !s.errors?.length, status: s.status, imported: s.imported, total: s.total, errors: s.errors };
  });

  await step('draft', async () => {
    const { generateDraft, printablePages } = await import('../src/core');
    const assets = await api<any[]>('GET', `/api/projects/${projectId}/assets`);
    const doc = (await api('GET', `/api/projects/${projectId}`)).doc;
    doc.settings.trimWidthMm = BLURB_LARGE_SQUARE_TRIM_MM;
    doc.settings.trimHeightMm = BLURB_LARGE_SQUARE_TRIM_MM;
    const draft = generateDraft(doc, assets, { targetPages: PAGES, stylePresetId: 'collage', ordering: 'chronological', includeCaptions: true, seed: 1 });
    await api('PUT', `/api/projects/${projectId}`, { doc: draft.doc, baseRevision: revision });
    const pages = printablePages(draft.doc).length;
    return { ok: pages > 0 && draft.report.selected > 0, pages, placed: draft.report.selected, assets: assets.length };
  });

  // Files the server reads from the app's resource folder, other than through the PDF.
  await step('textOutline', async () => {
    const o = await api('POST', '/api/text-outline', { text: 'Hello', fontFamily: 'Playfair Display', fontWeight: 700 });
    return { keys: Object.keys(o) };
  });
  await step('places', async () => {
    const p = await api<any[]>('POST', '/api/places/suggest', { points: [[-123.1, 49.28]] });
    return { ok: p.length > 0, first: p[0]?.name ?? p[0]?.id };
  });

  await step('exportPdf', async () => {
    const exp = await api('POST', `/api/projects/${projectId}/export`, {});
    exportFile = exp.file;
    const size = existsSync(exp.path) ? statSync(exp.path).size : -1;
    const cover = exp.cover ? { path: exp.cover.path, bytes: exp.cover.bytes, ok: exp.cover.verification?.ok } : null;
    return {
      ok: size > 100_000 && exp.verification?.ok === true && (!cover || cover.ok === true),
      path: exp.path, bytesOnDisk: size, pageCount: exp.verification?.pageCount, expectedPageCount: exp.verification?.expectedPageCount, problems: exp.verification?.problems, cover,
    };
  });

  await step('homePage', async () => {
    await win.loadURL(base + '/');
    const dom = await waitFor<{ rootChildren: number; text: string; title: string }>(
      `({ title: document.title, rootChildren: document.getElementById('root')?.children.length ?? -1, text: document.body.innerText.slice(0, 400) })`,
      (d) => d.rootChildren > 0 && d.text.includes(TITLE),
      20_000,
    );
    await sleep(1500);
    return { ok: dom.rootChildren > 0 && dom.text.includes(TITLE), dom, ...(await screenshot('home.png')) };
  });

  await step('editorPage', async () => {
    await js(`location.hash = '#/book/${projectId}'`);
    const probe = `({ hash: location.hash, imgs: document.images.length, imgsLoaded: [...document.images].filter((i) => i.complete && i.naturalWidth > 0).length, fonts: [...new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family))].slice(0, 12), text: document.body.innerText.slice(0, 200) })`;
    const dom = await waitFor<{ imgs: number; imgsLoaded: number }>(probe, (d) => d.imgs > 0 && d.imgsLoaded >= Math.min(d.imgs, 8), 30_000);
    await sleep(2500);
    const settled = await js<{ imgs: number; imgsLoaded: number }>(probe);
    return { ok: settled.imgs > 0 && settled.imgsLoaded > 0, dom: settled, firstSeen: dom, ...(await screenshot('editor.png')) };
  });

  // The editor's own buttons for the desktop extras: "Browse…" in the folder picker, and
  // "Open" / "Show in folder" (not a new-tab link) after an export made from the Export dialog.
  await step('desktopButtons', async () => {
    const r = await js<{ pathRow: string[]; exportButtons: string[]; newTabLinks: number }>(`(async () => {
      const wait = (ms) => new Promise((d) => setTimeout(d, ms));
      const click = (selector, text) => [...document.querySelectorAll(selector)].find((b) => b.innerText.trim() === text)?.click();
      click('button', 'Import');
      await wait(1000);
      const pathRow = [...document.querySelectorAll('.path-row button')].map((b) => b.innerText.trim());
      click('.modal-foot button', 'Cancel');
      await wait(400);
      click('button', 'Export PDF');
      await wait(800);
      click('.modal-foot button', 'Export PDFs');
      for (let i = 0; i < 120 && !document.querySelector('.export-result'); i++) await wait(500);
      const exportButtons = [...document.querySelectorAll('.export-result button')].map((b) => b.innerText.trim());
      const newTabLinks = document.querySelectorAll('.export-result a[target="_blank"]').length;
      return { pathRow, exportButtons, newTabLinks };
    })()`);
    const shot = await screenshot('export-dialog.png');
    await js(`[...document.querySelectorAll('.modal-foot button')].find((b) => b.innerText.trim() === 'Close')?.click()`);
    return { ok: r.pathRow.includes('Browse…') && r.exportButtons.includes('Open') && r.exportButtons.includes('Show in folder') && r.newTabLinks === 0, ...r, ...shot };
  });

  // The page is an ordinary web page with four extra functions, and cannot leave the app.
  await step('desktopApi', async () => {
    const r = await js<any>(`(async () => ({
      has: typeof window.desktop === 'object',
      version: window.desktop?.version,
      functions: ['pickFolder', 'openFile', 'showInFolder'].map((k) => typeof window.desktop?.[k]),
      openExport: await window.desktop.openFile(${JSON.stringify(exportFile)}),
      showExport: await window.desktop.showInFolder(${JSON.stringify(exportFile)}),
      openOutside: await window.desktop.openFile('..\\\\..\\\\photobook.sqlite'),
      openMissing: await window.desktop.openFile('no-such-file.pdf'),
      nodeInPage: typeof require !== 'undefined' || typeof process !== 'undefined',
      popup: window.open('/') !== null,
    }))()`);
    const ok = r.has && !!r.version && r.functions.every((t: string) => t === 'function') && r.openExport === true && r.showExport === true && r.openOutside === false && r.openMissing === false && !r.nodeInPage && !r.popup;
    return { ok, ...r };
  });

  // HEIC photos (iPhones): decoded by the bundled libheif, then treated like any other photo.
  // Passes with nothing to check when the folder has none; `heic` in the result says how many.
  await step('heicPhotos', async () => {
    const assets = (await api<any[]>('GET', `/api/projects/${projectId}/assets`)).filter(isHeic);
    const doc = (await api('GET', `/api/projects/${projectId}`)).doc;
    const placed = new Set<string>(doc.spreads.flatMap((sp: any) => sp.elements).filter((e: any) => e.type === 'image' && e.assetId).map((e: any) => e.assetId));
    const seen = [];
    for (const a of assets.slice(0, 3)) {
      const thumb = await measure(`/api/assets/${a.id}/thumb?size=s`);
      const preview = await measure(`/api/assets/${a.id}/thumb?size=m`);
      seen.push({ file: a.fileName, widthPx: a.widthPx, heightPx: a.heightPx, onPdfPages: placed.has(a.id), thumb, preview });
    }
    const good = (m: { width: number; spread: number }) => m.width > 0 && m.spread > 3;
    return { ok: seen.every((x) => x.widthPx > 0 && good(x.thumb) && good(x.preview)), heic: assets.length, heicOnPdfPages: assets.filter((a) => placed.has(a.id)).length, seen };
  });

  // A poster with one photo (a HEIC one when there is one), exported as PNG and JPEG: the print
  // PDF rendered by the bundled PDFium, measured in the page.
  await step('exportImage', async () => {
    const { addPhotoAt } = await import('../src/core');
    const created = await api('POST', '/api/projects', { title: 'Self-test poster', product: 'poster', sizeId: 'p11x14' });
    const id = created.doc.id;
    const job = await waitForJob(await api('POST', `/api/projects/${id}/import`, { folder: ctx.photos }));
    const assets = await api<any[]>('GET', `/api/projects/${id}/assets`);
    const photo = assets.find(isHeic) ?? assets[0];
    if (!photo) throw new Error(`No photo to put on the poster (import: ${JSON.stringify(job.errors)})`);
    const doc = addPhotoAt(created.doc, created.doc.spreads[0].id, photo, 140, 180).doc;
    await api('PUT', `/api/projects/${id}`, { doc, baseRevision: created.revision });
    const dpi = 150;
    const want = { width: Math.round((doc.settings.trimWidthMm / 25.4) * dpi), height: Math.round((doc.settings.trimHeightMm / 25.4) * dpi) };
    const out: Record<string, unknown> = {};
    let ok = true;
    for (const format of ['png', 'jpeg'] as const) {
      const r = await api('POST', `/api/projects/${id}/export-image`, { format, dpi });
      const seen = await measure(r.url);
      // One pixel either way: the trim is rounded from millimetres.
      ok &&= r.bytes > 10_000 && Math.abs(seen.width - want.width) <= 1 && Math.abs(seen.height - want.height) <= 1 && seen.width === r.widthPx && seen.spread > 3;
      out[format] = { file: r.file, bytes: r.bytes, widthPx: r.widthPx, heightPx: r.heightPx, dpi: r.dpi, seen };
    }
    return { ok, photo: photo.fileName, want, ...out };
  });

  // The flipbook: every page of the book rendered by PDFium and embedded in one HTML file.
  await step('exportFlipbook', async () => {
    const { printablePages } = await import('../src/core');
    const doc = (await api('GET', `/api/projects/${projectId}`)).doc;
    const r = await api('POST', `/api/projects/${projectId}/export-flipbook`, { size: 'standard' });
    const html = await (await fetch(base + r.url)).text();
    const data = JSON.parse(html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/)![1]);
    const pages: { width: number; height: number; spread: number; type: string }[] = [];
    for (const p of data.pages) pages.push(await measure(p.src));
    const covers = [];
    for (const c of [data.front, data.back]) if (c) covers.push(await measure(c));
    const expected = printablePages(doc).length;
    const sized = pages.every((p) => Math.abs(Math.max(p.width, p.height) - 1400) <= 2 && Math.abs(p.width / p.height - doc.settings.trimWidthMm / doc.settings.trimHeightMm) < 0.01);
    const pictured = pages.filter((p) => p.spread > 3).length;
    return {
      ok: r.pages === expected && pages.length === expected && sized && pictured >= Math.ceil(expected / 2) && covers.every((c) => c.width > 0),
      file: r.file, bytes: r.bytes, durationMs: r.durationMs, pages: pages.length, expected, pagesWithPictures: pictured, first: pages[0], covers,
    };
  });

  // Proof that the offline filter is switched on, without touching the network: a request to a
  // port on this computer that is not the app's must be cancelled before it is sent.
  await step('filterControl', async () => {
    const url = 'http://127.0.0.1:9/self-test-control';
    try {
      await ctx.session.fetch(url);
      return { ok: false, url, outcome: 'the request was sent' };
    } catch (e) {
      const outcome = String((e as Error)?.message ?? e);
      return { ok: /ERR_BLOCKED_BY_CLIENT/.test(outcome), url, outcome };
    }
  });

  await step('navigationBlocked', async () => {
    const before = win.webContents.getURL();
    await js(`void (location.href = 'http://127.0.0.1:9/self-test-navigation')`);
    await sleep(800);
    const after = win.webContents.getURL();
    return { ok: after === before, before, after };
  });

  return steps;
}

export const SELF_TEST_CONTROL_URLS = ['http://127.0.0.1:9/self-test-control', 'http://127.0.0.1:9/self-test-navigation'];
