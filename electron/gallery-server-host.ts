// Photo Tool's local server (photo-tool/server/app.ts) inside an Electron utility process, for the
// temporary `--gallery` program: see shared/electron/serverHost.ts.
import { join } from 'node:path';
import { taggingWorkerPath } from '../shared/electron/config';
import { resourceCheck, runServerHost } from '../shared/electron/serverHost';

runServerHost(async (msg) => {
  // Loaded here, not at the top: see runServerHost.
  const { createGalleryApp } = await import('../photo-tool/server/app');
  return createGalleryApp(msg.dataDir, {
    photoInfoFallbackDir: msg.photoInfoFallbackDir,
    // Built beside this bundle by scripts/desktop/build.mjs (both the packaged and the development build); run
    // from app.asar.unpacked in the installed app.
    tagging: { workerFile: taggingWorkerPath(__dirname) },
    // The desktop build keeps Photo Tool's page beside the editor's as web/gallery.html (until the programs are packaged apart).
    ...(msg.resourceRoot ? { resourceRoot: msg.resourceRoot, staticDir: join(msg.resourceRoot, 'web'), staticPage: 'gallery.html' } : { devWebUrl: msg.devWebUrl }),
  });
}, resourceCheck(['web/gallery.html']));
