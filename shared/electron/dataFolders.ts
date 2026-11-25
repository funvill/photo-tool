// Moving data to the programs' new names, once: Photobook Studio → Photobook Editor and Photobook
// Gallery → Photo Tool (each with " Dev" when run from source), and the editor's photo info for
// read-only folders (<editor data>/photoinfo) to the folder both programs share. A folder is only ever
// renamed, and only when the new one does not exist yet: nothing is copied, merged or deleted.
// Unit-tested in shared/tests/data-folders.test.ts.
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { photoInfoFallbackDir, programFolder } from './config';

/** The old folder could not be moved (most often: the old program is still running and holds it open). */
export class CarryOverError extends Error {
  constructor(
    public from: string,
    public to: string,
    cause: unknown,
  ) {
    super(`Could not move ${from} to ${to}: ${String((cause as Error)?.message ?? cause)}`, { cause });
    this.name = 'CarryOverError';
  }
}

export type CarryOverResult = 'moved' | 'nothing-to-move' | 'already-there';

/**
 * Rename `from` to `to` when `to` does not exist yet. `to` there already: both are left as they are
 * ('already-there'). `from` missing: nothing is made ('nothing-to-move'). A rename that fails throws a
 * CarryOverError and leaves `from` as it was.
 */
export function carryOver(from: string, to: string, rename: (a: string, b: string) => void = renameSync): CarryOverResult {
  if (existsSync(to)) return 'already-there';
  if (!existsSync(from)) return 'nothing-to-move';
  try {
    mkdirSync(dirname(to), { recursive: true });
    rename(from, to);
  } catch (e) {
    throw new CarryOverError(from, to, e);
  }
  return 'moved';
}

/**
 * Everything a program moves before it starts:
 *   1) its own folder, <appData>/<old>[ Dev] → <appData>/<new>[ Dev];
 *   2) the editor's photo info, from whichever of <appData>/Photobook Studio[ Dev]/data/photoinfo and
 *      <appData>/Photobook Editor[ Dev]/data/photoinfo exists first, to the shared fallback.
 * Either program may start first; the end is the same.
 *
 * Never in a test run, and never where the folders were chosen by hand: step 1 is 'skipped' when
 * ${envPrefix}_DATA_DIR or ${envPrefix}_PROFILE_DIR is set or a self-test runs, and step 2 when
 * PHOTOINFO_FALLBACK_DIR is set or a self-test runs.
 */
export function carryOverAll(o: {
  appData: string;
  packaged: boolean;
  oldProductName: string;
  productName: string;
  /** The program's environment prefix and environment: see the skips above. */
  envPrefix: string;
  env: Record<string, string | undefined>;
  selfTest?: boolean;
}): { data: CarryOverResult | 'skipped'; photoinfo: CarryOverResult | 'skipped' } {
  const folder = (name: string) => programFolder(o.appData, name, o.packaged);
  const dataGiven = !!o.env[`${o.envPrefix}_DATA_DIR`] || !!o.env[`${o.envPrefix}_PROFILE_DIR`];
  const data = o.selfTest || dataGiven ? 'skipped' : carryOver(folder(o.oldProductName), folder(o.productName));
  let photoinfo: CarryOverResult | 'skipped' = 'skipped';
  if (!o.selfTest && !o.env.PHOTOINFO_FALLBACK_DIR) {
    const to = photoInfoFallbackDir({ appData: o.appData, packaged: o.packaged, env: o.env });
    const from = [join(folder('Photobook Studio'), 'data', 'photoinfo'), join(folder('Photobook Editor'), 'data', 'photoinfo')].find((f) => existsSync(f));
    photoinfo = from ? carryOver(from, to) : 'nothing-to-move';
  }
  return { data, photoinfo };
}
