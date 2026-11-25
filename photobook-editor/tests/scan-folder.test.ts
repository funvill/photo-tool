// The editor's folder walk: supported files only, no dotfiles, numeric file-name order.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanFolder } from '../server/importer';

const TRIP = join(process.cwd(), 'fixtures', 'generated', 'trip');
let photos: string;

beforeEach(() => {
  photos = mkdtempSync(join(tmpdir(), 'scan-folder-'));
  cpSync(TRIP, photos, { recursive: true });
});
afterEach(() => rmSync(photos, { recursive: true, force: true }));

describe('scanFolder', () => {
  it('walks supported files in numeric order and skips dotfiles and other formats', async () => {
    mkdirSync(join(photos, '.hidden'));
    cpSync(join(TRIP, 'day1-01-arrival.jpg'), join(photos, '.hidden', 'x.jpg'));
    cpSync(join(TRIP, 'day1-01-arrival.jpg'), join(photos, 'img10.jpg'));
    cpSync(join(TRIP, 'day1-01-arrival.jpg'), join(photos, 'img9.jpg'));
    cpSync(join(TRIP, 'day1-01-arrival.jpg'), join(photos, '.dot.jpg'));
    writeFileSync(join(photos, 'notes.txt'), 'x');
    const names = (await scanFolder(photos, true)).map((f) => basename(f));
    expect(names.indexOf('img9.jpg')).toBeLessThan(names.indexOf('img10.jpg'));
    expect(names).not.toContain('x.jpg');
    expect(names).not.toContain('.dot.jpg');
    expect(names).not.toContain('notes.txt');
  });
});
