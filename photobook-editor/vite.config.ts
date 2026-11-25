import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The web UI talks only to the local API server (127.0.0.1). Nothing is fetched from the internet.
// Ports can be moved with PHOTOBOOK_WEB_PORT / PHOTOBOOK_PORT (e.g. to run a second copy).
const apiPort = Number(process.env.PHOTOBOOK_PORT ?? 5174);
const webPort = Number(process.env.PHOTOBOOK_WEB_PORT ?? 5173);

const projectDir = resolve(import.meta.dirname, '..');
const appVersion = (JSON.parse(readFileSync(resolve(projectDir, 'package.json'), 'utf8')) as { version: string }).version;

export default defineConfig({
  root: resolve(import.meta.dirname, 'web'),
  // web/public held the dropped web version's demo (sample photos, demo-welcome.js, overview/): never shipped.
  publicDir: false,
  plugins: [react()],
  // The in-browser backend (web/backend/browser) is no longer built: it stays in the code, switched off.
  // The version the pages show, so a build can be named exactly.
  define: { __BROWSER_BACKEND__: JSON.stringify(false), __APP_VERSION__: JSON.stringify(appVersion) },
  worker: { format: 'es' },
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: { '/api/': `http://127.0.0.1:${apiPort}` },
    fs: { allow: [projectDir] },
  },
  build: {
    outDir: resolve(projectDir, 'dist/photobook-editor/web'),
    emptyOutDir: true,
    target: 'es2022',
  },
});
