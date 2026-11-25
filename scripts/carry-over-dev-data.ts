// Running from source: split the old one-folder ./data layout per program (shared/server/devData.ts).
// scripts/desktop/dev.mjs and scripts/launcher/start.sh run this before they start a program. A part
// whose folder was chosen by hand (PHOTOBOOK_DATA_DIR, PHOTO_TOOL_DATA_DIR, PHOTOINFO_FALLBACK_DIR, or
// a _PROFILE_DIR) is left as it is; the other parts still move.
//
//   tsx scripts/carry-over-dev-data.ts
import { resolve } from 'node:path';
import { carryOverDevDataOrQuit, devCarryOverParts } from '../shared/server/devData';

const projectRoot = resolve(import.meta.dirname, '..');
const parts = devCarryOverParts(process.env);
if (!parts.length) {
  console.log('Data folders chosen by hand: ./data is left as it is.');
} else {
  const { moved, leftovers } = carryOverDevDataOrQuit(projectRoot, parts);
  if (!moved.length && !leftovers.length) console.log('./data is already split per program: nothing to move.');
}
