import { join, resolve } from 'node:path';
import { projectRoot, webDir } from '../../server/resources';
import { createGalleryApp } from './app';

// Development entry for the gallery's server (the desktop shell starts it itself in the packaged app).
// `--production` is the same as NODE_ENV=production, for shells that can't set a variable inline (Windows).
const production = process.env.NODE_ENV === 'production' || process.argv.includes('--production');
const root = projectRoot() ?? process.cwd();
const dataDir = resolve(process.env.PHOTOBOOK_GALLERY_DATA_DIR ?? join(root, 'data', 'gallery'));
// Read-only photo folders keep their info with the editor's, so a star set here reaches the editor.
const editorDataDir = resolve(process.env.PHOTOBOOK_DATA_DIR ?? join(root, 'data'));
const port = Number(process.env.PHOTOBOOK_GALLERY_PORT ?? 5176);
const webPort = Number(process.env.PHOTOBOOK_GALLERY_WEB_PORT ?? 5175);

const { app, close } = createGalleryApp(dataDir, {
  photoInfoFallbackDir: join(editorDataDir, 'photoinfo'),
  ...(production ? { staticDir: webDir() } : { devWebUrl: `http://127.0.0.1:${webPort}/gallery.html` }),
});

// 127.0.0.1 only: the API is never exposed to the local network.
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Photobook Gallery API on http://127.0.0.1:${port}  (data: ${dataDir})`);
});

const shutdown = () => {
  server.close(() => {
    close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
