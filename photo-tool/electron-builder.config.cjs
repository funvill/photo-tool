// Packaging for Photo Tool. `npm run dist:photo-tool` builds the installer for the platform it runs
// on (Windows: NSIS .exe; Linux: .deb and AppImage); `npm run dist:dir:photo-tool` only the unpacked
// folder. Run from the project folder: the paths below are relative to it.
//
// The app's name and id come from photo-tool/product.json and nowhere else.
// Everything the app needs is inside the installer: no nsis-web, no publish, no updater.
const { rmSync } = require('node:fs');
const { join } = require('node:path');
const product = require('./product.json');
const electronVersion = require('../node_modules/electron/package.json').version;
const linux = process.platform === 'linux';

// What scripts/desktop/build.mjs --program photo-tool makes.
const desktop = 'dist/photo-tool/desktop';

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: product.appId,
  // On Linux this name is also the install folder (/opt/<name>), and it must not have a space
  // in it: where Chromium has to fall back to its setuid sandbox it cuts the path at the space
  // and the app dies at start. So Linux installs under the package name; what the user sees comes
  // from linux.desktop below and from the app itself.
  productName: linux ? 'photo-tool' : product.productName,
  // The app folder holds the bundles, a small package.json and only the node_modules that have to
  // stay real folders. No source, tests, docs or photos.
  directories: { app: `${desktop}/app`, output: 'dist/installer/photo-tool', buildResources: desktop },
  // Use the Electron already in node_modules (see scripts/desktop/ensure-electron.mjs).
  electronDist: 'node_modules/electron/dist',
  electronVersion,
  files: ['**/*', '!**/*.map', '!**/*.d.ts', '!**/*.d.cts', '!**/*.d.mts', '!**/*.md', '!**/*.ts'],
  asar: true,
  // sharp, onnxruntime-node (photo tagging) and their DLLs only load from real files. The tagging worker thread is
  // started from a real file too (app.asar.unpacked/tagging-worker.cjs), and Node resolves its requires on the real
  // disk only, so every module it reaches must be there: all of node_modules (only the runtime modules build.mjs
  // copies) is unpacked, rather than a list that silently misses one.
  asarUnpack: ['node_modules/**', 'tagging-worker.cjs'],
  // The modules in the app folder are prebuilt for this platform already.
  npmRebuild: false,
  nodeGypRebuild: false,
  // World-atlas, the HEIC decoder and Photo Tool's built page, read by the server as plain files.
  extraResources: [{ from: `${desktop}/resources`, to: 'assets' }],
  // English only; Chromium's other locale packs are left out.
  electronLanguages: ['en-US'],
  publish: null,
  // Electron's own demo app comes along with the copied distribution; it is not ours to ship.
  afterPack: async (context) => {
    const resources = context.electronPlatformName === 'darwin' ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources') : join(context.appOutDir, 'resources');
    rmSync(join(resources, 'default_app.asar'), { force: true });
  },
  icon: `${desktop}/icon.png`,
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
  },
  nsis: {
    // One click, for the current user only, no administrator prompt.
    oneClick: true,
    perMachine: false,
    allowElevation: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    runAfterFinish: true,
    // Uninstalling never deletes the user's stars, thumbnails or settings.
    deleteAppDataOnUninstall: false,
    // No updater: leave out the elevation helper and the block map that only updates use.
    packElevateHelper: false,
    differentialPackage: false,
    artifactName: '${productName} Setup ${version}.${ext}',
  },
  linux: {
    target: [
      { target: 'deb', arch: ['x64'] },
      { target: 'AppImage', arch: ['x64'] },
    ],
    category: 'Graphics',
    // The name in the applications menu (see productName above).
    desktop: { entry: { Name: product.productName } },
    synopsis: product.description,
    maintainer: product.maintainer,
    // Name the .desktop file after desktopName in the app's package.json (see scripts/desktop/build.mjs).
    syncDesktopName: true,
    artifactName: '${name}-${version}-${arch}.${ext}',
    // One PNG per size (made by scripts/desktop/build.mjs); the launcher finds its icon by size.
    icon: `${desktop}/icons`,
  },
  deb: {
    packageCategory: 'graphics',
    // What the program is linked against and nothing else, so that `dpkg -i` with no network
    // succeeds on any desktop that can run it (see the editor's config for why each is there).
    // xdg-utils is what opens the data folder and shows a photo in its folder.
    depends: ['libgtk-3-0', 'libnss3', 'libgbm1', 'libasound2', 'libatspi2.0-0', 'libcups2', 'libxkbcommon0', 'xdg-utils'],
    // The default recommends libappindicator3-1 (a tray icon; the app has none), a package
    // that current Ubuntu and Debian no longer have.
    recommends: [],
  },
  // The AppImage is built with electron-builder's newer static runtime (still marked beta), which
  // mounts with the fuse3 current distributions have instead of libfuse2. PHOTOBOOK_APPIMAGE_TOOLSET=0.0.0
  // builds the old way.
  ...(linux ? { toolsets: { appimage: process.env.PHOTOBOOK_APPIMAGE_TOOLSET || '1.0.3' } } : {}),
};
