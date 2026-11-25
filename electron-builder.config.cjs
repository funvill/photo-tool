// Packaging for the desktop app. `npm run dist` builds the installer for the platform it runs
// on (Windows: NSIS .exe; Linux: .deb and AppImage); `npm run dist:dir` only the unpacked folder.
//
// The app's name and id come from electron/product.json and nowhere else.
// Everything the app needs is inside the installer: no nsis-web, no publish, no updater.
const { rmSync } = require('node:fs');
const { join } = require('node:path');
const product = require('./electron/product.json');
const electronVersion = require('./node_modules/electron/package.json').version;
const packageName = require('./package.json').name;
const linux = process.platform === 'linux';

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: product.appId,
  // On Linux this name is also the install folder (/opt/<name>), and it must not have a space
  // in it: where Chromium has to fall back to its setuid sandbox it cuts the path at the space
  // and the app dies at start ("failed to execvp: /opt/Photobook"). So Linux installs under the
  // package name; what the user sees comes from linux.desktop below and from the app itself.
  productName: linux ? packageName : product.productName,
  // dist/desktop/app is made by scripts/desktop/build.mjs: three bundles, a small package.json
  // and only the node_modules that have to stay real folders. No source, tests, docs or photos.
  directories: { app: 'dist/desktop/app', output: 'dist/installer', buildResources: 'dist/desktop' },
  // Use the Electron already in node_modules (see scripts/desktop/ensure-electron.mjs).
  electronDist: 'node_modules/electron/dist',
  electronVersion,
  files: ['**/*', '!**/*.map', '!**/*.d.ts', '!**/*.d.cts', '!**/*.d.mts', '!**/*.md', '!**/*.ts'],
  asar: true,
  // sharp, onnxruntime-node (photo tagging) and their DLLs only load from real files. The tagging worker thread is
  // started from a real file too (app.asar.unpacked/tagging-worker.cjs), and Node resolves its requires on the real
  // disk only, so every module it reaches must be there: all of node_modules (only the runtime modules build.mjs
  // copies) is unpacked, rather than a list that silently misses one (sharp's detect-libc did).
  asarUnpack: ['node_modules/**', 'tagging-worker.cjs'],
  // The modules in dist/desktop/app are prebuilt for this platform already.
  npmRebuild: false,
  nodeGypRebuild: false,
  // Fonts, world-atlas and the built editor, read by the server as plain files.
  extraResources: [{ from: 'dist/desktop/resources', to: 'assets' }],
  // The editor is English-only; Chromium's other locale packs are left out.
  electronLanguages: ['en-US'],
  publish: null,
  // Electron's own demo app comes along with the copied distribution; it is not ours to ship.
  afterPack: async (context) => {
    const resources = context.electronPlatformName === 'darwin' ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources') : join(context.appOutDir, 'resources');
    rmSync(join(resources, 'default_app.asar'), { force: true });
  },
  icon: 'dist/desktop/icon.png',
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
    // Uninstalling never deletes the user's books.
    deleteAppDataOnUninstall: false,
    // No updater: leave out the elevation helper and the block map that only updates use.
    packElevateHelper: false,
    differentialPackage: false,
    // Removes the copy of the installer that electron-builder would otherwise leave behind.
    include: 'electron/installer.nsh',
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
    icon: 'dist/desktop/icons',
  },
  deb: {
    packageCategory: 'graphics',
    // What the program is linked against and nothing else, so that `dpkg -i` with no network
    // succeeds on any desktop that can run it. electron-builder's default list asks for
    // libraries this app never loads (libnotify4, libsecret-1-0, libxss1, libxtst6, libuuid1)
    // and leaves out three it cannot start without (libgbm1, libasound2, libcups2).
    // xdg-utils is what opens an exported PDF and the data folder.
    depends: ['libgtk-3-0', 'libnss3', 'libgbm1', 'libasound2', 'libatspi2.0-0', 'libcups2', 'libxkbcommon0', 'xdg-utils'],
    // The default recommends libappindicator3-1 (a tray icon; the app has none), a package
    // that current Ubuntu and Debian no longer have.
    recommends: [],
    // A second launcher, "Photobook Gallery" (the same program with --gallery), in the
    // applications menu. electron-builder hands these to fpm before its own source=destination
    // pairs, so this is one more file mapped into the package. The path is absolute: fpm runs in
    // whatever folder the build was started from.
    fpm: [`${join(__dirname, 'electron', 'linux', 'photobook-gallery.desktop')}=/usr/share/applications/photobook-gallery.desktop`],
  },
  // The AppImage is built with electron-builder's newer static runtime (still marked beta).
  // Its default runtime needs libfuse2, which Ubuntu 22.04 and 24.04, Debian 12 and Fedora do
  // not install, so there a double-click does nothing at all; the static one mounts with the
  // fuse3 they do have (tested on Ubuntu 24.04). PHOTOBOOK_APPIMAGE_TOOLSET=0.0.0 builds the
  // old way.
  ...(linux ? { toolsets: { appimage: process.env.PHOTOBOOK_APPIMAGE_TOOLSET || '1.0.3' } } : {}),
};
