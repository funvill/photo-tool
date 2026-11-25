// The desktop app, for now one build of two programs: the editor, and with `--gallery [folder]`
// Photo Tool, each with its own name, data, server, window and single instance, so they run side by
// side. The shell itself (server, hardening, window, self-test, moving old data folders) is
// shared/electron/runDesktopApp.ts; this file only says what each program brings to it.
import { ipcMain } from 'electron';
import { join } from 'node:path';
import { launchFolder, parseSelfTest, selfTestOverlap } from '../shared/electron/config';
import { isAllowedRequest } from '../shared/electron/netGuard';
import { runDesktopApp, type DesktopProgram, type ProgramContext } from '../shared/electron/runDesktopApp';
import { GALLERY_APP_ID, GALLERY_PRODUCT_NAME, parseMode } from './config';
import { GALLERY_DESCRIPTION, galleryDrag, galleryEditActions, galleryFileActions, galleryFolders, galleryMapConsent, galleryPage, launchGallery, type LaunchData } from './gallery';
import { OSM_TILE_ORIGIN, galleryRequestAllowed, hostResolverRules, isMapTileRequest, mapTileRequestHeaders } from './mapTiles';
import product from './product.json';

/** The editor. */
function editor(): DesktopProgram {
  return {
    // The old names are written out: product.json takes the new name when the programs are packaged apart.
    names: { productName: 'Photobook Editor', envPrefix: 'PHOTOBOOK', oldProductName: 'Photobook Studio' },
    appUserModelId: 'app.photobookeditor.desktop',
    description: product.description,
    repository: product.repository,
    serverHostFile: 'server-host.cjs',
    page: (base) => base,
    hostResolverRules: hostResolverRules(false),
    requestAllowed: (url, _method, guard) => isAllowedRequest(url, guard),
    fileMenu: (ctx) => [{ label: 'Open &Gallery', click: () => launchGallery(ctx.log) }, { type: 'separator' }],
    registerIpc: (ctx) => {
      ipcMain.handle('desktop:open-gallery', (e) => {
        if (ctx.fromApp(e) && !ctx.selfTest) launchGallery(ctx.log);
      });
    },
    startMessage: () => ({}),
    selfTest: async (ctx) => (await import('./selfTest')).runSelfTest(ctx),
  };
}

/** Photo Tool, the temporary `--gallery` program. */
function photoTool(): DesktopProgram {
  const selfTest = parseSelfTest(process.argv);
  // The self-test opens a copy of the photos given, made in prepareSelfTest.
  const testPhotos = selfTest ? join(selfTest.out, 'photos') : null;
  let prepared: { sourceBefore: Record<string, string> } | null = null;
  let mapsOnline = false;
  let folders: ReturnType<typeof galleryFolders> | null = null;
  let edits: ReturnType<typeof galleryEditActions> | null = null;
  /** Photo Tool's own settings, beside Chromium's profile: `{ "mapsOnline": boolean, ... }`. */
  const settingsFile = (ctx: ProgramContext) => join(ctx.layout.profileDir, 'settings.json');
  const foldersFor = (ctx: ProgramContext) => (folders ??= galleryFolders({ window: ctx.window, fromApp: ctx.fromApp, log: ctx.log }, testPhotos ?? launchFolder(process.argv, !!process.defaultApp)));

  return {
    names: { productName: GALLERY_PRODUCT_NAME, envPrefix: 'PHOTO_TOOL', oldProductName: 'Photobook Gallery' },
    appUserModelId: GALLERY_APP_ID,
    description: GALLERY_DESCRIPTION,
    repository: product.repository,
    serverHostFile: 'gallery-server-host.cjs',
    page: galleryPage,
    // The one name Photo Tool may look up: the map tile server's, for its Map tab (see mapTiles.ts).
    hostResolverRules: hostResolverRules(true),
    // Tiles may load after the user chose Load maps, never during a self-test.
    requestAllowed: (url, method, guard) => galleryRequestAllowed(url, method, { ...guard, mapsAllowed: mapsOnline && !selfTest }),
    sendHeaders: (ses, version) => {
      // A tile request names the program and its version, nothing more (OpenStreetMap's tile policy):
      // only Accept and that User-Agent go out.
      ses.webRequest.onBeforeSendHeaders({ urls: [`${OSM_TILE_ORIGIN}/*`] }, (details, callback) => {
        if (!isMapTileRequest(details.url, details.method)) return callback({ cancel: true });
        callback({ requestHeaders: mapTileRequestHeaders(details.requestHeaders, version()) });
      });
    },
    fileMenu: (ctx) => foldersFor(ctx).fileMenu(),
    registerIpc: (ctx) => {
      foldersFor(ctx);
      const o = { window: ctx.window, fromApp: ctx.fromApp, serverPort: ctx.serverPort, log: ctx.log };
      // Dragging photos out: the main process asks Photo Tool's own server which files it may drag.
      galleryDrag(o);
      // The right-click menu's copy, show in folder and delete (to the Recycle Bin), same checks.
      galleryFileActions(o);
      // The edit setting, Save to file, Save as, and the question before closing with unsaved edits.
      edits = galleryEditActions({ ...o, file: settingsFile(ctx) });
      // The Map tab's "Load maps from the internet?" answer, kept here so the request guard can read it.
      galleryMapConsent({ window: ctx.window, fromApp: ctx.fromApp, file: settingsFile(ctx), onChange: (on) => (mapsOnline = on), log: ctx.log });
    },
    startMessage: () => ({}),
    // A second `--gallery <folder>` launch opens that folder.
    singleInstanceData: () => ({ argv: process.argv, cwd: process.cwd() }) satisfies LaunchData,
    onSecondInstance: (data) => folders?.secondInstance(data),
    confirmQuit: () => !edits || edits.confirmQuit(),
    onWindow: (win) => {
      folders?.watch(win);
      edits?.watch(win);
    },
    prepareSelfTest: async () => {
      if (!selfTest) return;
      // Before the page can ask for the folder (galleryFolders hands it over once the page listens).
      const { prepareGalleryPhotos } = await import('./selfTest');
      prepared = prepareGalleryPhotos(selfTest.photos, selfTest.out);
    },
    selfTest: async (ctx) => {
      const { runGallerySelfTest } = await import('./selfTest');
      if (!prepared || !testPhotos) throw new Error('The self-test photos were not prepared.');
      return runGallerySelfTest({ ...ctx, photos: testPhotos, source: ctx.photos, sourceBefore: prepared.sourceBefore });
    },
  };
}

const isGallery = parseMode(process.argv).mode === 'gallery';
if (isGallery) {
  // Photo Tool's self-test replaces <out>/photos with a copy of the photos given. When the two folders
  // overlap it stops here, before anything (the profile, the log, result.json, that copy) is written.
  const selfTest = parseSelfTest(process.argv);
  const refused = selfTest ? selfTestOverlap(selfTest.photos, selfTest.out) : null;
  if (refused) {
    console.error(`Self-test refused: ${refused} Nothing was deleted or written.`);
    process.exit(1);
  }
}
runDesktopApp(isGallery ? photoTool() : editor());
