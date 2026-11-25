// The editor's desktop program: what it brings to the shared desktop shell
// (shared/electron/runDesktopApp.ts, which runs the server, the hardening, the window, the self-test and
// moving the old data folder). Photo Tool is its own program (photo-tool/electron/main.ts).
import { hostResolverRules, isAllowedRequest } from '../shared/electron/netGuard';
import { runDesktopApp, type DesktopProgram } from '../shared/electron/runDesktopApp';
import product from './product.json';

/** The editor. */
function editor(): DesktopProgram {
  return {
    // The old names are written out: product.json takes the new name when the editor is packaged apart.
    names: { productName: 'Photobook Editor', envPrefix: 'PHOTOBOOK', oldProductName: 'Photobook Studio' },
    appUserModelId: 'app.photobookeditor.desktop',
    description: product.description,
    repository: product.repository,
    serverHostFile: 'server-host.cjs',
    page: (base) => base,
    // No name is ever looked up.
    hostResolverRules: hostResolverRules(),
    requestAllowed: (url, _method, guard) => isAllowedRequest(url, guard),
    fileMenu: () => [],
    registerIpc: () => {},
    startMessage: () => ({}),
    selfTest: async (ctx) => (await import('./selfTest')).runSelfTest(ctx),
  };
}

runDesktopApp(editor());
