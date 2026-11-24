import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The web UI talks only to the local API server (127.0.0.1). Nothing is fetched from the internet.
// Ports can be moved with PHOTOBOOK_WEB_PORT / PHOTOBOOK_PORT (e.g. to run a second copy).
//
// `--mode pages` builds the web version instead: the backend runs in the browser (IndexedDB,
// workers), there is no server, and the files are served from GitHub Pages under /photobook_studio/.
const apiPort = Number(process.env.PHOTOBOOK_PORT ?? 5174);
const webPort = Number(process.env.PHOTOBOOK_WEB_PORT ?? 5173);

// The gallery program's page (desktop only): src/gallery/web/index.html, served and built as
// /gallery.html beside the editor's page. It lives outside the root (src/web), so:
//   build  the input is src/web/gallery.html, which is not on disk: the plugin loads the gallery's
//          page in its place, its script pointed back at src/gallery/web
//   dev    /gallery.html is the gallery's page, its script pointed at src/gallery/web under /@fs/
//          (how Vite serves files outside the root)
const galleryHtml = resolve(import.meta.dirname, 'src/gallery/web/index.html');
const galleryInput = resolve(import.meta.dirname, 'src/web/gallery.html');
const slashes = (p: string) => p.replace(/\\/g, '/');
const galleryPageWithScript = (src: string) => readFileSync(galleryHtml, 'utf8').replace('src="./main.tsx"', `src="${src}"`);

function galleryPage(): Plugin {
  return {
    name: 'photobook-gallery-page',
    configureServer(server) {
      const script = `/@fs/${slashes(resolve(galleryHtml, '../main.tsx')).replace(/^\//, '')}`;
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/gallery.html') return next();
        server
          .transformIndexHtml('/gallery.html', galleryPageWithScript(script), req.originalUrl)
          .then((html) => res.setHeader('Content-Type', 'text/html').end(html))
          .catch(next);
      });
    },
    resolveId(id) {
      return slashes(id) === slashes(galleryInput) ? galleryInput : null;
    },
    load(id) {
      return slashes(id) === slashes(galleryInput) ? galleryPageWithScript('../gallery/web/main.tsx') : null;
    },
  };
}

export default defineConfig(({ mode }) => {
  const pages = mode === 'pages';
  return {
    root: 'src/web',
    base: pages ? '/photobook_studio/' : '/',
    // The web version's demo (sample photos, the portfolio's demo-welcome.js) ships only there.
    publicDir: pages ? 'public' : false,
    plugins: [react(), ...(pages ? [] : [galleryPage()])],
    define: { __BROWSER_BACKEND__: JSON.stringify(pages) },
    worker: { format: 'es' },
    server: {
      host: '127.0.0.1',
      port: webPort,
      strictPort: true,
      proxy: pages ? undefined : { '/api/': `http://127.0.0.1:${apiPort}` },
      fs: { allow: ['../..'] },
    },
    build: {
      outDir: pages ? '../../dist/pages' : '../../dist/web',
      emptyOutDir: true,
      target: 'es2022',
      rollupOptions: pages ? undefined : { input: { index: resolve(import.meta.dirname, 'src/web/index.html'), gallery: galleryInput } },
    },
  };
});
