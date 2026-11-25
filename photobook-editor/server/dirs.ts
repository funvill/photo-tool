// Where the editor's server keeps its data when run from source: pure, so it can be tested without
// starting a server (shared/tests/dev-data.test.ts). Also used by scripts/draft-from-folder.ts.
import { resolve } from 'node:path';
import { devCarryOverParts, devDataLayout, type DevDataPart } from '../../shared/server/devData';

export function resolveDirs(env: Record<string, string | undefined>, root: string): { dataDir: string; photoInfoFallbackDir: string; carryOver: DevDataPart[] } {
  const layout = devDataLayout(root);
  return {
    // Only the profile given: the data goes beside it, as the desktop shell does (shared/electron/config.ts
    // dataLayout), not into ./data/photobook-editor, whose carry-over that variable skips.
    dataDir: env.PHOTOBOOK_DATA_DIR ? resolve(env.PHOTOBOOK_DATA_DIR) : env.PHOTOBOOK_PROFILE_DIR ? `${resolve(env.PHOTOBOOK_PROFILE_DIR)}-data` : layout.editor,
    // Read-only photo folders keep their info in a folder shared with Photo Tool, so a star set there reaches the editor.
    photoInfoFallbackDir: resolve(env.PHOTOINFO_FALLBACK_DIR ?? layout.photoinfo),
    // The parts of the old ./data layout this server carries over: its own and the shared photo info,
    // each only when its folder was not chosen by hand.
    carryOver: devCarryOverParts(env, ['editor', 'photoinfo']),
  };
}
