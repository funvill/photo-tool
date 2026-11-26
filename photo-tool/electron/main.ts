// Photo Tool's desktop program: what it brings to the shared desktop shell
// (shared/electron/runDesktopApp.ts, which runs the server, the hardening, the window, the self-test and
// moving the old data folder). Started as `Photo Tool [folder]`: the folder given opens at once.
import { join } from 'node:path';
import { launchFolder, parseSelfTest, selfTestOverlap } from '../../shared/electron/config';
import { runDesktopApp, type DesktopProgram, type ProgramContext } from '../../shared/electron/runDesktopApp';
import product from '../product.json';
import { galleryDrag, galleryEditActions, galleryFileActions, galleryFolders, galleryMapConsent, type LaunchData } from './gallery';
import { OSM_TILE_ORIGIN, galleryRequestAllowed, isMapTileRequest, mapHostResolverRules, mapTileRequestHeaders } from './mapTiles';

/** Tell the page to show its keyboard shortcuts (nothing happens while no page is there to listen). */
function showShortcuts(ctx: ProgramContext) {
  const w = ctx.window();
  if (w && !w.isDestroyed()) w.webContents.send('gallery:show-shortcuts');
}

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
    // The old name is written out: its data folder moves to the new one once (shared/electron/dataFolders.ts).
    names: { productName: product.productName, envPrefix: 'PHOTO_TOOL', oldProductName: 'Photobook Gallery' },
    appUserModelId: product.appId,
    description: product.description,
    repository: product.repository,
    serverHostFile: 'server-host.cjs',
    // The page is index.html at the server's root (or the Vite dev server's).
    page: (base) => base,
    // The one name Photo Tool may look up: the map tile server's, for its Map tab (see mapTiles.ts).
    hostResolverRules: mapHostResolverRules(),
    updateChannel: 'photo-tool',
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
    // Help > Keyboard shortcuts shows the page's own list (the ? key's), after About.
    helpMenu: (ctx) => [{ label: '&Keyboard shortcuts', click: () => showShortcuts(ctx) }],
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
    // A second launch with a folder opens that folder.
    singleInstanceData: () => ({ argv: process.argv, cwd: process.cwd(), defaultApp: !!process.defaultApp }) satisfies LaunchData,
    onSecondInstance: (data) => folders?.secondInstance(data),
    confirmQuit: () => !edits || edits.confirmQuit(),
    allowClose: (on) => edits?.allowClose(on),
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

// The self-test replaces <out>/photos with a copy of the photos given. When the two folders overlap it
// stops here, before anything (the profile, the log, result.json, that copy) is written.
const selfTest = parseSelfTest(process.argv);
const refused = selfTest ? selfTestOverlap(selfTest.photos, selfTest.out) : null;
if (refused) {
  console.error(`Self-test refused: ${refused} Nothing was deleted or written.`);
  process.exit(1);
}
runDesktopApp(photoTool());
