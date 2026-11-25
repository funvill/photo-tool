// Runs the local server (src/server/app.ts, the same one `npm start` runs) inside an Electron
// utility process, so a long PDF export never freezes the window; with `kind: 'gallery'`, the
// gallery's server (src/gallery/server/app.ts) instead. The main process sends
// { type: 'start', ... }, gets { type: 'ready', port } or { type: 'error', error } back, and sends
// { type: 'stop' } before quitting so the database is closed properly.
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import type { Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

export interface StartMessage {
  type: 'start';
  /** Which server: the editor's (src/server/app.ts) or the gallery's (src/gallery/server/app.ts). */
  kind: 'editor' | 'gallery';
  dataDir: string;
  /** Gallery only: where photo info for read-only folders is kept (the editor's `<dataDir>/photoinfo`). */
  photoInfoFallbackDir?: string;
  /** 0 = any free port. */
  port: number;
  /** The packaged resource folder (fonts, world-atlas, web). Left out when running from source. */
  resourceRoot?: string;
  /** Development: the Vite dev server that shows the editor. */
  devWebUrl?: string;
}
export type HostMessage = StartMessage | { type: 'stop' };
export type HostReply = { type: 'ready'; port: number } | { type: 'error'; error: string } | { type: 'stopped' } | { type: 'restart' };

const errorText = (e: unknown) => String((e as Error)?.stack ?? e);

/** A packaged app with files missing would otherwise start and fail later, in the middle of an export. */
function checkResources(root: string, kind: StartMessage['kind']) {
  const missing: string[] = [];
  const page = join(root, 'web', kind === 'gallery' ? 'gallery.html' : 'index.html');
  if (!existsSync(page)) missing.push(page);
  if (!existsSync(join(root, 'world-atlas', 'countries-10m.json'))) missing.push(join(root, 'world-atlas', 'countries-10m.json'));
  // The HEIC decoder and the PDF renderer (see src/server/resources.ts).
  for (const f of [join(root, 'libheif', 'libheif-bundle.js'), join(root, 'pdfium', 'index.cjs'), join(root, 'pdfium', 'pdfium.wasm')]) if (!existsSync(f)) missing.push(f);
  const fonts = join(root, 'fonts');
  if (!existsSync(fonts) || !readdirSync(fonts).some((f) => f.endsWith('.woff'))) missing.push(join(fonts, '*.woff'));
  if (missing.length) throw new Error(`App files are missing:\n  ${missing.join('\n  ')}`);
}

/** The express app for `msg.kind`, and how to close what it holds open (its database). */
async function createServer(msg: StartMessage, post: (m: HostReply) => void): Promise<{ app: Express; close: () => void }> {
  // Loaded here, not at the top: if sharp (a native module) cannot load, the import throws, and
  // this way the reason reaches the main process as a message.
  if (msg.kind === 'gallery') {
    if (!msg.photoInfoFallbackDir) throw new Error('The gallery needs photoInfoFallbackDir.');
    const { createGalleryApp } = await import('../src/gallery/server/app');
    return createGalleryApp(msg.dataDir, {
      photoInfoFallbackDir: msg.photoInfoFallbackDir,
      // Built beside this bundle by scripts/desktop/build.mjs (both the packaged and the development build).
      tagging: { workerFile: join(__dirname, 'tagging-worker.cjs') },
      ...(msg.resourceRoot ? { resourceRoot: msg.resourceRoot, staticDir: join(msg.resourceRoot, 'web') } : { devWebUrl: msg.devWebUrl }),
    });
  }
  const { createApp } = await import('../src/server/app');
  const restart = () => post({ type: 'restart' });
  const { app, store } = createApp(
    msg.dataDir,
    msg.resourceRoot ? { resourceRoot: msg.resourceRoot, staticDir: join(msg.resourceRoot, 'web'), restart } : { devWebUrl: msg.devWebUrl },
  );
  return { app, close: () => store.close() };
}

async function start(msg: StartMessage, post: (m: HostReply) => void) {
  if (msg.resourceRoot) checkResources(msg.resourceRoot, msg.kind);
  mkdirSync(msg.dataDir, { recursive: true });
  const { app, close: closeApp } = await createServer(msg, post);
  // 127.0.0.1 only: never reachable from the network.
  const server = await new Promise<Server>((done, fail) => {
    const s = app.listen(msg.port, '127.0.0.1', () => done(s));
    s.once('error', fail);
  });
  const close = () =>
    new Promise<void>((done) => {
      server.close(() => {
        closeApp();
        done();
      });
      server.closeAllConnections();
    });
  return { port: (server.address() as AddressInfo).port, close };
}

const parentPort = (process as unknown as { parentPort?: Electron.ParentPort }).parentPort;
if (parentPort) {
  const post = (m: HostReply) => parentPort.postMessage(m);
  let running: Awaited<ReturnType<typeof start>> | null = null;
  parentPort.on('message', (e: Electron.MessageEvent) => {
    const msg = e.data as HostMessage;
    void (async () => {
      if (msg.type === 'start') {
        try {
          running = await start(msg, post);
          post({ type: 'ready', port: running.port });
        } catch (err) {
          post({ type: 'error', error: errorText(err) });
        }
      } else if (msg.type === 'stop') {
        try {
          await running?.close();
        } catch (err) {
          console.error(err);
        }
        post({ type: 'stopped' });
        process.exit(0);
      }
    })();
  });
  process.on('uncaughtException', (err) => {
    console.error('uncaughtException', errorText(err));
    process.exit(1);
  });
}
