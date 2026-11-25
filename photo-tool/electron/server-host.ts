// Photo Tool's local server (photo-tool/server/app.ts, the same one `npm run dev:photo-tool` runs)
// inside an Electron utility process: see shared/electron/serverHost.ts.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { taggingWorkerPath } from '../../shared/electron/config';
import { runServerHost } from '../../shared/electron/serverHost';

/**
 * The files Photo Tool's server reads from the resource root (see shared/server/resources.ts): its page,
 * the place outlines and the HEIC decoder. It embeds no fonts and renders no PDFs, so it needs neither.
 */
export const PHOTO_TOOL_RESOURCES = ['web/index.html', 'world-atlas/countries-10m.json', 'libheif/libheif-bundle.js'];

/** Throws `App files are missing: …` naming each missing file: a packaged app would otherwise fail later. */
export function checkPhotoToolResources(root: string): void {
  const missing = PHOTO_TOOL_RESOURCES.map((f) => join(root, f)).filter((f) => !existsSync(f));
  if (missing.length) throw new Error(`App files are missing:\n  ${missing.join('\n  ')}`);
}

runServerHost(async (msg) => {
  // Loaded here, not at the top: see runServerHost.
  const { createGalleryApp } = await import('../server/app');
  return createGalleryApp(msg.dataDir, {
    photoInfoFallbackDir: msg.photoInfoFallbackDir,
    // Built beside this bundle by scripts/desktop/build.mjs (both the packaged and the development build); run
    // from app.asar.unpacked in the installed app.
    tagging: { workerFile: taggingWorkerPath(__dirname) },
    ...(msg.resourceRoot ? { resourceRoot: msg.resourceRoot, staticDir: join(msg.resourceRoot, 'web') } : { devWebUrl: msg.devWebUrl }),
  });
}, checkPhotoToolResources);
