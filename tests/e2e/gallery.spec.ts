// The gallery program: open a folder, see its photos in the grid, and star one from its tile —
// the star lands in the folder's photoinfo.json, where the editor will find it.
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { isSupported } from '../../src/server/media';

const FIXTURES = join(process.cwd(), 'fixtures', 'generated', 'trip');

test('open a folder, see every photo, star one from the grid', async ({ page, request }) => {
  // A private copy, so the star is written there and not into the fixtures.
  const dir = join(mkdtempSync(join(tmpdir(), 'photobook-gallery-')), 'trip');
  cpSync(FIXTURES, dir, { recursive: true });
  // One tile per photo the gallery reads (SUPPORTED_EXTENSIONS), not per file.
  const count = readdirSync(dir).filter(isSupported).length;
  expect(count).toBeGreaterThan(0);
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

test('step through the viewer and star a photo with one key', async ({ page, request }) => {
  const dir = join(mkdtempSync(join(tmpdir(), 'photobook-gallery-')), 'trip');
  cpSync(FIXTURES, dir, { recursive: true });
  try {
    expect((await request.post('/api/gallery/open', { data: { folder: dir, recursive: false } })).status()).toBe(202);
    await page.goto('/');
    await page.getByRole('button', { name: dir }).click();
    const tiles = page.locator('.gallery-tile');
    await expect(tiles).toHaveCount(readdirSync(dir).filter(isSupported).length, { timeout: 60_000 });
    await expect(page.getByRole('progressbar')).toHaveCount(0, { timeout: 60_000 });
    const third = await tiles.nth(2).locator('img').getAttribute('alt');

    // Double-click opens the viewer on tile 1; it shows the large (1600 px) picture.
    await tiles.first().dblclick();
    const viewer = page.getByRole('dialog', { name: 'Photo viewer' });
    await expect(viewer).toBeVisible();
    await expect(viewer.locator('img')).toHaveAttribute('src', /size=m/);
    await expect(viewer).toContainText('1 / ');

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(viewer.locator('img')).toHaveAttribute('alt', third!);
    await expect(viewer).toContainText('3 / ');
    // I shows the photo's details, read-only; I again hides them.
    await page.keyboard.press('i');
    await expect(viewer.getByRole('complementary', { name: 'Photo details' })).toContainText(third!);
    await page.keyboard.press('i');
    await expect(viewer.getByRole('complementary', { name: 'Photo details' })).toHaveCount(0);

    await page.keyboard.press('s');
    await expect(viewer.getByLabel('Starred')).toBeVisible();
    const info = join(dir, 'photoinfo.json');
    await expect.poll(() => (existsSync(info) ? readFileSync(info, 'utf8') : '')).toContain('"star": true');
    expect(JSON.parse(readFileSync(info, 'utf8')).photos).toEqual({ [third!]: { star: true } });

    // Esc closes and selects the last photo viewed, in the grid.
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
    await expect(page.locator('.gallery-tile.selected img')).toHaveAttribute('alt', third!);
    await expect(page.getByRole('complementary', { name: 'Photo details' })).toContainText(third!);

    // Enter opens it again on the selected photo.
    await page.keyboard.press('Enter');
    await expect(viewer).toContainText('3 / ');
    await page.keyboard.press('Escape');
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
});
