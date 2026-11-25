import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app';
import { resolveDirs } from './dirs';
import { carryOverDevDataOrQuit } from '../../shared/server/devData';
import { projectRoot, webDir } from '../../shared/server/resources';

// `--production` is the same as NODE_ENV=production, for shells that can't set a variable inline (Windows).
const production = process.env.NODE_ENV === 'production' || process.argv.includes('--production');
const root = projectRoot();
// ./data/photobook-editor and ./data/photoinfo-shared, or the folders the environment names (dirs.ts).
const { dataDir, photoInfoFallbackDir, carryOver } = resolveDirs(process.env, root ?? process.cwd());
// The old one-folder ./data layout is split per program first, once: the parts whose folders are the defaults.
carryOverDevDataOrQuit(root ?? process.cwd(), carryOver);
const port = Number(process.env.PHOTOBOOK_PORT ?? 5174);

const webPort = Number(process.env.PHOTOBOOK_WEB_PORT ?? 5173);
// Restart = run the launcher's start script in the background: it rebuilds the editor if the code
// changed, stops this server and starts a fresh one on the same port and data folder. The launcher
// is macOS-only (and needs the source tree); elsewhere there is no restart and the editor hides it.
const launcher = root && process.platform === 'darwin' ? join(root, 'scripts/launcher/start.sh') : null;
const restart = launcher && existsSync(launcher)
  ? () => {
      spawn('bash', [launcher], {
        cwd: root!, detached: true, stdio: 'ignore',
        env: { ...process.env, PHOTOBOOK_PORT: String(port), PHOTOBOOK_DATA_DIR: dataDir, PHOTOINFO_FALLBACK_DIR: photoInfoFallbackDir },
      }).unref();
    }
  : undefined;
const { app, store } = createApp(dataDir, { photoInfoFallbackDir, ...(production ? { staticDir: webDir('photobook-editor'), restart } : { devWebUrl: `http://127.0.0.1:${webPort}/` }) });

// 127.0.0.1 only: the API is never exposed to the local network.
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Photobook Editor API on http://127.0.0.1:${port}  (data: ${dataDir})`);
  console.log(production ? `\n  Open the editor: http://127.0.0.1:${port}\n` : `\n  Open the editor: http://127.0.0.1:${webPort}  (this port only serves data)\n`);
});

const shutdown = () => {
  server.close(() => {
    store.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
