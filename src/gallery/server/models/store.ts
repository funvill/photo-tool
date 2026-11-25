// Where downloaded tagging models live (<dataDir>/models/<id>/) and which ones the person chose (<dataDir>/tagging.json).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODEL_CATALOGUE, type ModelChoice } from '../../../core/tagModels';

export const modelDir = (dataDir: string, id: string): string => join(dataDir, 'models', id);

export interface InstalledModel {
  id: string;
  bytes: number;
  /** Every file present with the catalogue's size. */
  ok: boolean;
}

const sizeOf = (path: string): number | null => {
  try {
    const s = statSync(path);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
};

/** Models with a folder in `<dataDir>/models`, in catalogue order. A partial download (only `.part` files) counts as not installed. */
export function installedModels(dataDir: string, catalogue: readonly ModelChoice[] = MODEL_CATALOGUE): InstalledModel[] {
  const out: InstalledModel[] = [];
  for (const m of catalogue) {
    const dir = modelDir(dataDir, m.id);
    if (!existsSync(dir)) continue;
    const sizes = m.files.map((f) => sizeOf(join(dir, f.path)));
    if (sizes.every((s) => s === null)) continue;
    out.push({
      id: m.id,
      bytes: sizes.reduce<number>((a, s) => a + (s ?? 0), 0),
      ok: m.files.every((f, i) => sizes[i] === f.bytes),
    });
  }
  return out;
}

export function removeModel(dataDir: string, id: string): void {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Not a model id: ${id}`);
  rmSync(modelDir(dataDir, id), { recursive: true, force: true });
}

export interface TaggingSettings {
  describe: string | null;
  keywords: string | null;
  paused: boolean;
}

const settingsFile = (dataDir: string) => join(dataDir, 'tagging.json');

export function readTaggingSettings(dataDir: string): TaggingSettings {
  try {
    const raw = JSON.parse(readFileSync(settingsFile(dataDir), 'utf8')) as Partial<TaggingSettings>;
    return {
      describe: typeof raw.describe === 'string' ? raw.describe : null,
      keywords: typeof raw.keywords === 'string' ? raw.keywords : null,
      paused: raw.paused === true,
    };
  } catch {
    return { describe: null, keywords: null, paused: false };
  }
}

export function writeTaggingSettings(dataDir: string, s: TaggingSettings): void {
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${settingsFile(dataDir)}.tmp`;
  writeFileSync(tmp, JSON.stringify({ describe: s.describe, keywords: s.keywords, paused: s.paused }, null, 2));
  renameSync(tmp, settingsFile(dataDir));
}
