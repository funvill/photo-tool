// Running from source: split the old one-folder ./data layout per program (shared/server/devData.ts).
// scripts/desktop/dev.mjs runs this before it starts a program. Does nothing when a data or profile
// folder was chosen by hand (PHOTOBOOK_DATA_DIR, PHOTO_TOOL_DATA_DIR, PHOTOINFO_FALLBACK_DIR, …).
//
//   tsx scripts/carry-over-dev-data.ts
import { resolve } from 'node:path';
import { carryOverDevDataOrQuit, devCarryOverSkipped } from '../shared/server/devData';

const projectRoot = resolve(import.meta.dirname, '..');
if (devCarryOverSkipped(process.env)) {
  console.log('Data folders chosen by hand: ./data is left as it is.');
} else {
  const { moved } = carryOverDevDataOrQuit(projectRoot);
  if (!moved.length) console.log('./data is already split per program: nothing to move.');
}
