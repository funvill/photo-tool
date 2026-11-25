// Where Photo Tool's server keeps its data when run from source: pure, so it can be tested without
// starting a server (shared/tests/dev-data.test.ts).
import { resolve } from 'node:path';
import { devCarryOverParts, devDataLayout, type DevDataPart } from '../../shared/server/devData';

export function resolveDirs(env: Record<string, string | undefined>, root: string): { dataDir: string; photoInfoFallbackDir: string; carryOver: DevDataPart[] } {
  const layout = devDataLayout(root);
  return {
    // Only the profile given: the data goes beside it, as the desktop shell does (shared/electron/config.ts
    // dataLayout), not into ./data/photo-tool, whose carry-over that variable skips.
    dataDir: env.PHOTO_TOOL_DATA_DIR ? resolve(env.PHOTO_TOOL_DATA_DIR) : env.PHOTO_TOOL_PROFILE_DIR ? `${resolve(env.PHOTO_TOOL_PROFILE_DIR)}-data` : layout.photoTool,
    // Read-only photo folders keep their info in a folder shared with the Photobook Editor, so a star set here reaches it.
    photoInfoFallbackDir: resolve(env.PHOTOINFO_FALLBACK_DIR ?? layout.photoinfo),
    // The parts of the old ./data layout this server carries over: its own and the shared photo info,
    // each only when its folder was not chosen by hand.
    carryOver: devCarryOverParts(env, ['photoTool', 'photoinfo']),
  };
}
