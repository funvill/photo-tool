// `npm run dev:desktop:editor` and `npm run dev:desktop:photo-tool`: a program's desktop window
// onto its Vite dev server (hot reload for the page), with its API server running inside the app as it
// does when installed.
//
//   node scripts/desktop/dev.mjs --program photobook-editor|photo-tool [args for the app]
//
// Each program uses the ports and data folder of its own `npm run dev:*`, so run one or the other, not
// both: the editor PHOTOBOOK_WEB_PORT 5173 / PHOTOBOOK_PORT 5174 and ./data/photobook-editor (or
// PHOTOBOOK_DATA_DIR); Photo Tool PHOTO_TOOL_WEB_PORT 5175 / PHOTO_TOOL_PORT 5176 and ./data/photo-tool
// (or PHOTO_TOOL_DATA_DIR). Both keep stars for read-only folders in ./data/photoinfo-shared (or
// PHOTOINFO_FALLBACK_DIR). Both programs' data and profile folders are always given, so neither ever
// moves an old data folder under %APPDATA%. Changes to a program's electron/ or server/ need this
// command restarted; changes to its page reload by themselves. Photo Tool opens a folder given after
// the program name: `npm run dev:desktop:photo-tool -- D:\Pictures`.
import { execFileSync, spawn } from 'node:child_process';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { ensureElectron } from './ensure-electron.mjs';
import { programArg, withoutProgramArg } from './programs.mjs';

const root = resolve(import.meta.dirname, '../..');
const program = programArg(process.argv);
const photoTool = program === 'photo-tool';
const prefix = photoTool ? 'PHOTO_TOOL' : 'PHOTOBOOK';
const webPort = Number(process.env[`${prefix}_WEB_PORT`] ?? (photoTool ? 5175 : 5173));
const apiPort = Number(process.env[`${prefix}_PORT`] ?? (photoTool ? 5176 : 5174));
const env = {
  ...process.env,
  // Vite and the app's server both read these.
  [`${prefix}_WEB_PORT`]: String(webPort),
  [`${prefix}_PORT`]: String(apiPort),
  PHOTOBOOK_DATA_DIR: resolve(process.env.PHOTOBOOK_DATA_DIR ?? join(root, 'data', 'photobook-editor')),
  PHOTOBOOK_PROFILE_DIR: resolve(process.env.PHOTOBOOK_PROFILE_DIR ?? join(root, 'data', 'photobook-editor-browser')),
  PHOTO_TOOL_DATA_DIR: resolve(process.env.PHOTO_TOOL_DATA_DIR ?? join(root, 'data', 'photo-tool')),
  PHOTO_TOOL_PROFILE_DIR: resolve(process.env.PHOTO_TOOL_PROFILE_DIR ?? join(root, 'data', 'photo-tool-browser')),
  PHOTOINFO_FALLBACK_DIR: resolve(process.env.PHOTOINFO_FALLBACK_DIR ?? join(root, 'data', 'photoinfo-shared')),
  [`${prefix}_DESKTOP_DEV_URL`]: `http://127.0.0.1:${webPort}/`,
};
delete env.ELECTRON_RUN_AS_NODE;

const electron = ensureElectron();
execFileSync(process.execPath, [join(root, 'scripts/desktop/build.mjs'), '--program', program, '--dev'], { cwd: root, stdio: 'inherit' });

const vite = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--config', join(root, program, 'vite.config.ts')], { cwd: root, env, stdio: 'inherit' });
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

// What is left after --program goes to the app (Photo Tool: a folder to open).
app = spawn(electron, [join(root, 'dist', program, 'desktop', 'dev'), ...withoutProgramArg(process.argv.slice(2))], { cwd: root, env, stdio: 'inherit' });
app.on('exit', (code) => stop(code ?? 0));
