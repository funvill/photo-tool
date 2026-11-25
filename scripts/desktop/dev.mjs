// `npm run dev:desktop`: the desktop window onto the Vite dev server (hot reload for the editor),
// with the API server running inside the app as it does when installed.
//
// Same ports and data folder as `npm run dev` (PHOTOBOOK_WEB_PORT 5173, PHOTOBOOK_PORT 5174,
// ./data or PHOTOBOOK_DATA_DIR), so run one or the other, not both. Changes under electron/ or
// src/server need this command restarted; changes to the editor reload by themselves.
//
// `npm run dev:desktop -- --gallery [folder]` is the gallery program the same way, on the ports of
// the gallery's own dev server (photo-tool/server/main.ts: PHOTOBOOK_GALLERY_WEB_PORT 5175,
// PHOTOBOOK_GALLERY_PORT 5176) and with its data in ./data/gallery (or PHOTOBOOK_GALLERY_DATA_DIR),
// so it runs beside the editor's. Its stars for read-only folders go to the editor's data folder.
import { execFileSync, spawn } from 'node:child_process';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { ensureElectron } from './ensure-electron.mjs';

const root = resolve(import.meta.dirname, '../..');
const gallery = process.argv.includes('--gallery');
const webPort = Number((gallery ? process.env.PHOTOBOOK_GALLERY_WEB_PORT : process.env.PHOTOBOOK_WEB_PORT) ?? (gallery ? 5175 : 5173));
const apiPort = Number((gallery ? process.env.PHOTOBOOK_GALLERY_PORT : process.env.PHOTOBOOK_PORT) ?? (gallery ? 5176 : 5174));
const env = {
  ...process.env,
  // Vite and the app's server both read these.
  PHOTOBOOK_WEB_PORT: String(webPort),
  PHOTOBOOK_PORT: String(apiPort),
  PHOTOBOOK_DATA_DIR: resolve(process.env.PHOTOBOOK_DATA_DIR ?? join(root, 'data')),
  ...(gallery ? { PHOTOBOOK_GALLERY_DATA_DIR: resolve(process.env.PHOTOBOOK_GALLERY_DATA_DIR ?? join(root, 'data', 'gallery')) } : {}),
  PHOTOBOOK_DESKTOP_DEV_URL: `http://127.0.0.1:${webPort}/`,
};
delete env.ELECTRON_RUN_AS_NODE;

const electron = ensureElectron();
execFileSync(process.execPath, [join(root, 'scripts/desktop/build.mjs'), '--dev'], { cwd: root, stdio: 'inherit' });

const vite = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js')], { cwd: root, env, stdio: 'inherit' });
let app = null;
const stop = (code) => {
  vite.kill();
  app?.kill();
  process.exit(code);
};
vite.on('exit', (code) => {
  if (!app) console.error('The Vite dev server stopped before the window opened.');
  stop(code ?? 1);
});
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

const listening = (port) =>
  new Promise((done) => {
    const s = connect(port, '127.0.0.1');
    s.once('connect', () => (s.destroy(), done(true)));
    s.once('error', () => done(false));
  });
for (let i = 0; i < 120 && !(await listening(webPort)); i++) await new Promise((d) => setTimeout(d, 250));

app = spawn(electron, [join(root, 'dist/desktop/dev'), ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit' });
app.on('exit', (code) => stop(code ?? 0));
