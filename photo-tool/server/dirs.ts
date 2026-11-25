// Where Photo Tool's server keeps its data when run from source: pure, so it can be tested without
// starting a server (shared/tests/dev-data.test.ts).
import { resolve } from 'node:path';
import { devCarryOverSkipped, devDataLayout } from '../../shared/server/devData';

export function resolveDirs(env: Record<string, string | undefined>, root: string): { dataDir: string; photoInfoFallbackDir: string; carryOver: boolean } {
  const layout = devDataLayout(root);
  return {
    dataDir: resolve(env.PHOTO_TOOL_DATA_DIR ?? layout.photoTool),
    // Read-only photo folders keep their info in a folder shared with the Photobook Editor, so a star set here reaches it.
    photoInfoFallbackDir: resolve(env.PHOTOINFO_FALLBACK_DIR ?? layout.photoinfo),
    // Only on the default ./data folders: folders chosen by hand are never moved.
    carryOver: !devCarryOverSkipped(env),
  };
}
