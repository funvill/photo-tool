import { join, resolve } from 'node:path';
import { projectRoot, webDir } from '../../shared/server/resources';
import { createGalleryApp } from './app';
import { taggingWorkerSource } from './tagging/workerSource';

// Photo Tool's server (the desktop shell starts the same app itself in the packaged app).
// `--production` is the same as NODE_ENV=production, for shells that can't set a variable inline (Windows).
const production = process.env.NODE_ENV === 'production' || process.argv.includes('--production');
const root = projectRoot() ?? process.cwd();
const dataDir = resolve(process.env.PHOTO_TOOL_DATA_DIR ?? join(root, 'data', 'photo-tool'));
// Read-only photo folders keep their info in a folder shared with the Photobook Editor, so a star set here reaches it.
const photoInfoFallbackDir = resolve(process.env.PHOTOINFO_FALLBACK_DIR ?? join(root, 'data', 'photoinfo-shared'));
const port = Number(process.env.PHOTO_TOOL_PORT ?? 5176);
const webPort = Number(process.env.PHOTO_TOOL_WEB_PORT ?? 5175);

// End-to-end tests only: fake tagging models served from memory, never the network.
const fake = process.env.PHOTO_TOOL_FAKE_TAGGING === '1' ? await import('../tests/support/fakeTagging') : null;

const { app, close } = createGalleryApp(dataDir, {
  photoInfoFallbackDir,
  tagging: fake
    ? { fetch: fake.fakeFetch({ chunkDelayMs: 40 }), catalogue: fake.FAKE_CATALOGUE, backend: fake.fakeBackend({ delayMs: 40 }), imageOf: async (p: { path: string }) => p.path }
    : { workerFile: taggingWorkerSource() },
  ...(production ? { staticDir: webDir('photo-tool') } : { devWebUrl: `http://127.0.0.1:${webPort}/` }),
});

// 127.0.0.1 only: the API is never exposed to the local network.
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Photo Tool API on http://127.0.0.1:${port}  (data: ${dataDir})`);
});

const shutdown = () => {
  server.close(() => {
    close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
