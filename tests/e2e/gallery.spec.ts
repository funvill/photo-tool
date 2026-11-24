// The gallery program: open a folder, see its photos in the grid, and star one from its tile —
// the star lands in the folder's photoinfo.json, where the editor will find it.
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const FIXTURES = join(process.cwd(), 'fixtures', 'generated', 'trip');

test('open a folder, see every photo, star one from the grid', async ({ page, request }) => {
  // A private copy, so the star is written there and not into the fixtures.
  const dir = join(mkdtempSync(join(tmpdir(), 'photobook-gallery-')), 'trip');
  cpSync(FIXTURES, dir, { recursive: true });
  const count = readdirSync(dir).length;
  try {
    // Open it through the API (a plain browser has no folder dialog): it becomes a recent folder.
    expect((await request.post('/api/gallery/open', { data: { folder: dir, recursive: false } })).status()).toBe(202);

    await page.goto('/');
    await page.getByRole('button', { name: dir }).click();

    const tiles = page.locator('.gallery-tile');
    await expect(tiles).toHaveCount(count, { timeout: 60_000 });
    await expect(page.getByRole('progressbar')).toHaveCount(0, { timeout: 60_000 });

    const first = tiles.first();
    const name = await first.locator('img').getAttribute('alt');
    await first.hover();
    await first.getByRole('button', { name: 'Star', exact: true }).click();
    await expect(first.getByLabel('Starred')).toBeVisible();

    const info = join(dir, 'photoinfo.json');
    await expect.poll(() => (existsSync(info) ? readFileSync(info, 'utf8') : '')).toContain('"star": true');
    expect(JSON.parse(readFileSync(info, 'utf8')).photos[name!]).toEqual({ star: true });
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
});
