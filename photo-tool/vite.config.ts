import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Photo Tool's page: photo-tool/web/index.html, built to dist/photo-tool/web. The page talks only to
// Photo Tool's own local API server (127.0.0.1); nothing is fetched from the internet.
// Ports can be moved with PHOTO_TOOL_WEB_PORT / PHOTO_TOOL_PORT (e.g. to run a second copy).
const apiPort = Number(process.env.PHOTO_TOOL_PORT ?? 5176);
const webPort = Number(process.env.PHOTO_TOOL_WEB_PORT ?? 5175);

const projectDir = resolve(import.meta.dirname, '..');
const appVersion = (JSON.parse(readFileSync(resolve(projectDir, 'package.json'), 'utf8')) as { version: string }).version;

export default defineConfig({
  root: resolve(import.meta.dirname, 'web'),
  base: '/',
  publicDir: false,
  plugins: [react()],
  // The version shown in the top bar, so a build can be named exactly.
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: { '/api/': `http://127.0.0.1:${apiPort}` },
    // The page imports shared/ (outside its root).
    fs: { allow: [projectDir] },
  },
  build: {
    outDir: resolve(projectDir, 'dist/photo-tool/web'),
    emptyOutDir: true,
    target: 'es2022',
  },
});
