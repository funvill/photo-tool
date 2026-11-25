// Create a Blurb Large Square book from a folder of photos and auto-draft it, without the editor.
//
//   npx tsx scripts/draft-from-folder.ts <photo folder> [title] [pages] [style]
//
// The book lands in the same data directory the app uses (./data, or PHOTOBOOK_DATA_DIR), so it
// is on the home page the next time the app starts. Stop the app first: both write the database.

import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { generateDraft, printablePages, type BookDocument, type PhotoAsset } from '../photobook-editor/core';
import { createApp } from '../photobook-editor/server/app';

const [folderArg, title = 'Untitled book', pagesArg = '86', style = 'collage'] = process.argv.slice(2);
if (!folderArg) {
  console.error('Usage: npx tsx scripts/draft-from-folder.ts <photo folder> [title] [pages] [style]');
  process.exit(1);
}
const folder = resolve(folderArg);
const pages = Number(pagesArg);
const dataDir = resolve(process.env.PHOTOBOOK_DATA_DIR ?? 'data');

// Blurb's Large Square trims to 11.75 in, not 12: the PDF page is 855 x 864 pt with 9 pt of bleed
// on the top, bottom and outside edges (Blurb's size calculator, checked 2026-11-22).
const BLURB_LARGE_SQUARE_TRIM_MM = 11.75 * 25.4;

const { app, store } = createApp(dataDir);
const server = await new Promise<Server>((done) => {
  const s = app.listen(0, '127.0.0.1', () => done(s));
});
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = (await res.json()) as T;
  if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${JSON.stringify(json)}`);
  return json;
}

try {
  const created = await api('POST', '/api/projects', { title, printerId: 'blurb', bindingId: 'hardcover', sizeId: 'blurb-sq12', stylePresetId: style, pages });
  const id: string = created.doc.id;

  const job = await api('POST', `/api/projects/${id}/import`, { folder });
  let status = job;
  while (status.status !== 'done' && status.status !== 'failed') {
    await new Promise((r) => setTimeout(r, 1000));
    status = await api('GET', `/api/jobs/${job.id}`);
  }
  if (status.status === 'failed' || status.errors?.length) console.error('Import problems:', status.errors);
  console.log(`Imported ${status.imported} of ${status.total} photos from ${folder}`);

  const assets = await api<PhotoAsset[]>('GET', `/api/projects/${id}/assets`);
  const doc: BookDocument = (await api('GET', `/api/projects/${id}`)).doc;
  doc.settings.trimWidthMm = BLURB_LARGE_SQUARE_TRIM_MM;
  doc.settings.trimHeightMm = BLURB_LARGE_SQUARE_TRIM_MM;

  const draft = generateDraft(doc, assets, { targetPages: pages, stylePresetId: style, ordering: 'chronological', includeCaptions: true, seed: 1 });
  await api('PUT', `/api/projects/${id}`, { doc: draft.doc, baseRevision: created.revision });
  console.log(`Drafted "${title}": ${printablePages(draft.doc).length} pages, ${draft.report.selected} of ${assets.length} photos placed.`);
  console.log(`Saved in ${dataDir}`);
} finally {
  server.close();
  store.close();
}
