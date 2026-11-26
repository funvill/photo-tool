// Photobook Editor's desktop program: what it brings to the shared desktop shell
// (shared/electron/runDesktopApp.ts, which runs the server, the hardening, the window, the self-test and
// moving the old data folder). Photo Tool is its own program (photo-tool/electron/main.ts).
import { ipcMain, shell } from 'electron';
import { existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { hostResolverRules, isAllowedRequest } from '../../shared/electron/netGuard';
import { runDesktopApp, type DesktopProgram, type ProgramContext } from '../../shared/electron/runDesktopApp';
import { UPDATE_HOSTS } from '../../shared/electron/updateRules';
import product from '../product.json';

/** The page's "Open" and "Show in folder" for an exported file, named by its file name in the exports folder. */
function exportActions(ctx: ProgramContext) {
  /** An export's file name → its full path, or null when it is not a file in the exports folder. */
  const exportPath = (name: unknown): string | null => {
    if (typeof name !== 'string' || !name || basename(name) !== name) return null;
    const path = join(ctx.layout.dataDir, 'exports', name);
    return existsSync(path) && statSync(path).isFile() ? path : null;
  };
  ipcMain.handle('desktop:open-file', async (e, name: unknown) => {
    const path = ctx.fromApp(e) ? exportPath(name) : null;
    if (!path) return false;
    if (ctx.selfTest) return true; // a test must not pop a PDF viewer open
    const problem = await shell.openPath(path);
    if (problem) {
      // No app for this kind of file: showing where it is still helps.
      ctx.log('could not open', path, problem);
      shell.showItemInFolder(path);
    }
    return true;
  });
  ipcMain.handle('desktop:show-in-folder', (e, name: unknown) => {
    const path = ctx.fromApp(e) ? exportPath(name) : null;
    if (!path) return false;
    if (!ctx.selfTest) shell.showItemInFolder(path);
    return true;
  });
}

function editor(): DesktopProgram {
  return {
    // The old name is written out: its data folder moves to the new one once (shared/electron/dataFolders.ts).
    names: { productName: product.productName, envPrefix: 'PHOTOBOOK', oldProductName: 'Photobook Studio' },
    appUserModelId: product.appId,
    description: product.description,
    repository: product.repository,
    serverHostFile: 'server-host.cjs',
    page: (base) => base,
    // No name is ever looked up but GitHub's, for the updater (the window still reaches only its own server).
    hostResolverRules: hostResolverRules(UPDATE_HOSTS),
    updateChannel: 'photobook-editor',
    requestAllowed: (url, _method, guard) => isAllowedRequest(url, guard),
    fileMenu: () => [],
    registerIpc: (ctx) => exportActions(ctx),
    startMessage: () => ({}),
    selfTest: async (ctx) => (await import('./selfTest')).runSelfTest(ctx),
  };
}

runDesktopApp(editor());
