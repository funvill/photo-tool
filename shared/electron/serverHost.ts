// Runs a program's local server inside an Electron utility process, so long work (a PDF export, a
// folder scan) never freezes the window. The program's own server-host entry passes in how to make
// its express app and which resource files it needs. The main process (runDesktopApp.ts) sends
// { type: 'start', ... }, gets { type: 'ready', port } or { type: 'error', error } back, and sends
// { type: 'stop' } before quitting so the database is closed properly.
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import type { Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

export interface StartMessage {
  type: 'start';
  dataDir: string;
  /** Where photo info for read-only folders is kept: the folder both programs share. */
  photoInfoFallbackDir: string;
  /** 0 = any free port. */
  port: number;
  /** The packaged resource folder (fonts, world-atlas, web). Left out when running from source. */
  resourceRoot?: string;
  /** Development: the Vite dev server that shows the page. */
  devWebUrl?: string;
}
export type HostMessage = StartMessage | { type: 'stop' };
export type HostReply = { type: 'ready'; port: number } | { type: 'error'; error: string } | { type: 'stopped' } | { type: 'restart' };

const errorText = (e: unknown) => String((e as Error)?.stack ?? e);

/**
 * A check for runServerHost: the resource files every program needs, and `pages` (relative to the
 * resource root, e.g. 'web/index.html'). A packaged app with files missing would otherwise start and
 * fail later, in the middle of an export.
 */
export function resourceCheck(pages: readonly string[]): (root: string) => void {
  return (root) => {
    const missing: string[] = [];
    for (const page of pages) if (!existsSync(join(root, page))) missing.push(join(root, page));
    if (!existsSync(join(root, 'world-atlas', 'countries-10m.json'))) missing.push(join(root, 'world-atlas', 'countries-10m.json'));
    // The HEIC decoder and the PDF renderer (see shared/server/resources.ts).
    for (const f of [join(root, 'libheif', 'libheif-bundle.js'), join(root, 'pdfium', 'index.cjs'), join(root, 'pdfium', 'pdfium.wasm')]) if (!existsSync(f)) missing.push(f);
    const fonts = join(root, 'fonts');
    if (!existsSync(fonts) || !readdirSync(fonts).some((f) => f.endsWith('.woff'))) missing.push(join(fonts, '*.woff'));
    if (missing.length) throw new Error(`App files are missing:\n  ${missing.join('\n  ')}`);
  };
}

async function start(msg: StartMessage, post: (m: HostReply) => void, create: Parameters<typeof runServerHost>[0], checkResources: (root: string) => void) {
  if (msg.resourceRoot) checkResources(msg.resourceRoot);
  mkdirSync(msg.dataDir, { recursive: true });
  // `create` loads the server itself: if sharp (a native module) cannot load, the import throws, and
  // this way the reason reaches the main process as a message.
  const { app, close: closeApp } = await create(msg, post);
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

/** The utility process's body: answer the main process's start and stop. Does nothing outside one. */
export function runServerHost(create: (msg: StartMessage, post: (m: HostReply) => void) => Promise<{ app: Express; close: () => void }>, checkResources: (root: string) => void): void {
  const parentPort = (process as unknown as { parentPort?: Electron.ParentPort }).parentPort;
  if (!parentPort) return;
  const post = (m: HostReply) => parentPort.postMessage(m);
  let running: Awaited<ReturnType<typeof start>> | null = null;
  parentPort.on('message', (e: Electron.MessageEvent) => {
    const msg = e.data as HostMessage;
    void (async () => {
      if (msg.type === 'start') {
        try {
          running = await start(msg, post, create, checkResources);
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
