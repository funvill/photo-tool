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
  // Nothing is copied in as is: everything the page uses is imported by its code.
  publicDir: false,
  plugins: [react()],
  // The version the pages show, so a build can be named exactly.
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
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
