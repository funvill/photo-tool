// The importer applies the edit saved in a folder's photoinfo.json and re-renders when it changes.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBook } from '../src/core';
import { Importer } from '../src/server/importer';
import { Store } from '../src/server/db';

let root: string;
let photos: string;
let dataDir: string;
let store: Store;
let importer: Importer;
let projectId: string;

const EDIT = { rotate: 90, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 } };
const writeInfo = (edit?: unknown) =>
  writeFileSync(join(photos, 'photoinfo.json'), JSON.stringify({ format: 'photoinfo/1', photos: { 'a.jpg': edit ? { edit } : {} } }));
const sync = async () => importer.wait(importer.sync(projectId, [photos], new Set()).id);
const row = () => store.assetByPath(join(photos, 'a.jpg'))!;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'pb-importer-edit-'));
  photos = join(root, 'photos');
  dataDir = join(root, 'data');
  mkdirSync(photos);
  await sharp({ create: { width: 400, height: 300, channels: 3, background: '#336699' } }).jpeg().toFile(join(photos, 'a.jpg'));
  store = new Store(dataDir);
  const book = createBook({ title: 'Edit', pages: 8 });
  store.createProject(book);
  projectId = book.id;
  importer = new Importer(store, { fallbackDir: join(dataDir, 'photoinfo') });
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('importer with a saved edit', () => {
  it('renders the edit, and goes back to the original when it is removed', async () => {
    writeInfo(EDIT);
    const first = await sync();
    expect(first.imported).toBe(1);
    const a = row();
    expect([a.width, a.height]).toEqual([300, 400]);
    expect(a.derived_path).toBeTruthy();
    expect(a.derived_path!.startsWith(join(dataDir, 'derived'))).toBe(true);
    expect(basename(a.derived_path!)).toMatch(/-edit-[0-9a-z]+\.jpg$/);
    expect(existsSync(a.derived_path!)).toBe(true);

    // Same edit again: nothing is rendered again.
    const again = await sync();
    expect(again.alreadyInLibrary).toBe(1);
    expect(again.imported).toBe(0);

    // Edit removed: processed again from the original.
    writeInfo();
    const undone = await sync();
    expect(undone.imported).toBe(1);
    const b = row();
    expect([b.width, b.height]).toEqual([400, 300]);
    expect(b.derived_path).toBeNull();
    expect(b.id).toBe(a.id);
  });

  it('treats an identity edit as no edit', async () => {
    writeInfo({ rotate: 0, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 } });
    await sync();
    expect(row().derived_path).toBeNull();
    expect((await sync()).alreadyInLibrary).toBe(1);
  });

  it('re-renders when the edit changes', async () => {
    writeInfo(EDIT);
    await sync();
    const first = row().derived_path;
    writeInfo({ ...EDIT, rotate: 180 });
    const job = await sync();
    expect(job.imported).toBe(1);
    expect(row().derived_path).not.toBe(first);
    expect([row().width, row().height]).toEqual([400, 300]);
  });
});
