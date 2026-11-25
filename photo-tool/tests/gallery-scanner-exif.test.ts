// The scan's exif upgrade of a cached photo: a file that can't be read just then (locked, a drive gone
// for a moment) leaves the cached row as it was, so its camera stays and exif is tried again next time.
import { DatabaseSync } from 'node:sqlite';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const unreadable = vi.hoisted(() => ({ on: false }));
vi.mock('../../shared/server/media', async (importOriginal) => {
  const media = await importOriginal<typeof import('../../shared/server/media')>();
  return {
    ...media,
    readMetadata: async (path: string) =>
      unreadable.on ? { capturedAt: null, gpsLat: null, gpsLon: null, camera: null, exif: {}, read: false } : media.readMetadata(path),
  };
});

const { Catalog } = await import('../server/catalog');
const { Scanner } = await import('../server/scanner');

const TRIP = join(process.cwd(), 'fixtures', 'generated', 'trip');
const NAME = 'day1-01-arrival.jpg';

let root: string;
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gallery-exif-'));
  dataDir = join(root, 'data');
  cpSync(join(TRIP, NAME), join(root, 'trip', NAME));
  unreadable.on = false;
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

async function scan(): Promise<void> {
  const catalog = new Catalog(dataDir);
  try {
    const scanner = new Scanner(catalog, dataDir, { analyze: async () => ({ sharpness: 1, meanLuma: 0.5, clippedShadows: 0, clippedHighlights: 0, dHash: '0', saliencyX: 0.5, saliencyY: 0.5 }) });
    const job = await scanner.wait(scanner.open(join(root, 'trip'), false).id);
    expect(job.errors).toEqual([]);
  } finally {
    catalog.close();
  }
}

const row = () => {
  const db = new DatabaseSync(join(dataDir, 'gallery.sqlite'));
  try {
    return db.prepare('SELECT camera, exif FROM photos').get() as { camera: string | null; exif: string | null };
  } finally {
    db.close();
  }
};

describe('scanner exif upgrade', () => {
  it('keeps the cached row when the file cannot be read, and fills exif in once it can', async () => {
    await scan();
    expect(row().camera).toBe('Photobook Fixture Synthetic');
    const db = new DatabaseSync(join(dataDir, 'gallery.sqlite'));
    db.prepare('UPDATE photos SET exif = NULL').run();
    db.close();

    unreadable.on = true;
    await scan();
    expect(row()).toEqual({ camera: 'Photobook Fixture Synthetic', exif: null });

    unreadable.on = false;
    await scan();
    expect(row().exif).not.toBeNull();
    expect(row().camera).toBe('Photobook Fixture Synthetic');
  });
});
