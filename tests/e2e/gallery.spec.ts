// The gallery program: open a folder, review its photos (grid, preview pane, keys, stacks, hidden
// photos) and star one — the star lands in the folder's photoinfo.json, where the editor will find it.
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { isSupported } from '../../src/server/media';

const FIXTURES = join(process.cwd(), 'fixtures', 'generated', 'trip');

/** A private copy of the trip fixture (so stars and hides are written there), opened and fully read. */
async function openTrip(page: Page, request: APIRequestContext, seed?: Record<string, Record<string, unknown>>): Promise<string> {
  const dir = join(mkdtempSync(join(tmpdir(), 'photobook-gallery-')), 'trip');
  cpSync(FIXTURES, dir, { recursive: true });
  // Photo info the folder starts with (a photoinfo.json written before the gallery reads it).
  if (seed) writeFileSync(join(dir, 'photoinfo.json'), JSON.stringify({ format: 'photoinfo/1', photos: seed }, null, 2));
  // Open it through the API (a plain browser has no folder dialog): it becomes a recent folder.
  expect((await request.post('/api/gallery/open', { data: { folder: dir, recursive: false } })).status()).toBe(202);
  // A wide thumbnail column of small tiles: the grid draws only the rows on screen, and every tile
  // should be on screen so the tests can count them.
  await page.addInitScript(() => {
    localStorage.setItem('gallery.gridWidth', '900');
    localStorage.setItem('gallery.thumbSize', '96');
  });
  await page.goto('/');
  await page.getByRole('button', { name: dir }).click();
  await expect(page.locator('.gallery-tile').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('progressbar')).toHaveCount(0, { timeout: 60_000 });
  return dir;
}

const removeTrip = (dir: string) => rmSync(join(dir, '..'), { recursive: true, force: true });

/** The folder's photoinfo.json entries, by file name ({} while there is none). */
function photoInfo(dir: string): Record<string, Record<string, unknown>> {
  const file = join(dir, 'photoinfo.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).photos ?? {}) : {};
}

const altOf = (page: Page, nth: number) => page.locator('.gallery-tile img').nth(nth).getAttribute('alt');
const selectedImg = (page: Page) => page.locator('.gallery-tile.selected img');

test('open a folder, see every photo, star one from the grid', async ({ page, request }) => {
  const dir = await openTrip(page, request);
  try {
    // With stacking off, one tile per photo the gallery reads (SUPPORTED_EXTENSIONS), not per file.
    await page.getByLabel('Stack similar').uncheck();
    const count = readdirSync(dir).filter(isSupported).length;
    expect(count).toBeGreaterThan(0);
    const tiles = page.locator('.gallery-tile');
    await expect(tiles).toHaveCount(count);

    const first = tiles.first();
    const name = await first.locator('img').getAttribute('alt');
    await first.hover();
    await first.getByRole('button', { name: 'Star', exact: true }).click();
    await expect(first.getByLabel('Starred')).toBeVisible();

    const info = join(dir, 'photoinfo.json');
    await expect.poll(() => (existsSync(info) ? readFileSync(info, 'utf8') : '')).toContain('"star": true');
    expect(JSON.parse(readFileSync(info, 'utf8')).photos[name!]).toEqual({ star: true });
  } finally {
    removeTrip(dir);
  }
});

test('step through the viewer and star a photo with one key', async ({ page, request }) => {
  const dir = await openTrip(page, request);
  try {
    const tiles = page.locator('.gallery-tile');
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
    await expect.poll(() => photoInfo(dir)).toEqual({ [third!]: { star: true } });

    // Esc closes and selects the last photo viewed, in the grid.
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
    await expect(selectedImg(page)).toHaveAttribute('alt', third!);
    await expect(page.getByRole('complementary', { name: 'Photo details' })).toContainText(third!);

    // Enter opens it again on the selected photo.
    await page.keyboard.press('Enter');
    await expect(viewer).toContainText('3 / ');
    await page.keyboard.press('Escape');
  } finally {
    removeTrip(dir);
  }
});

test('preview pane shows the selected photo and follows ArrowRight', async ({ page, request }) => {
  const dir = await openTrip(page, request);
  try {
    const first = await altOf(page, 0);
    const second = await altOf(page, 1);
    const preview = page.getByRole('region', { name: 'Preview' });
    // The first photo is selected once the folder is read; the pane shows its large picture.
    await expect(selectedImg(page)).toHaveAttribute('alt', first!);
    await expect(preview.locator('img')).toHaveAttribute('alt', first!);
    await expect(preview.locator('img')).toHaveAttribute('src', /size=m/);
    await expect(preview).toContainText(first!);

    await page.keyboard.press('ArrowRight');
    await expect(selectedImg(page)).toHaveAttribute('alt', second!);
    await expect(preview.locator('img')).toHaveAttribute('alt', second!);
    await page.keyboard.press('Home');
    await expect(preview.locator('img')).toHaveAttribute('alt', first!);
    // Moving through the photos writes nothing.
    await page.waitForTimeout(500);
    expect(photoInfo(dir)).toEqual({});

    // Double-click on the preview opens the viewer on it.
    await preview.locator('img').dblclick();
    const viewer = page.getByRole('dialog', { name: 'Photo viewer' });
    await expect(viewer.locator('img')).toHaveAttribute('alt', first!);
    await page.keyboard.press('Escape');
  } finally {
    removeTrip(dir);
  }
});

test('F stars the selected photo and the tile shows the star badge', async ({ page, request }) => {
  const dir = await openTrip(page, request);
  try {
    const first = await altOf(page, 0);
    await expect(selectedImg(page)).toHaveAttribute('alt', first!);
    await page.keyboard.press('f');
    await expect(page.locator('.gallery-tile.selected').getByLabel('Starred')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Preview' })).toContainText('Favourite');
    await expect.poll(() => photoInfo(dir)[first!]).toEqual({ star: true });
  } finally {
    removeTrip(dir);
  }
});

test('H hides the photo, it leaves the grid, the next photo is selected; Hidden: Show brings it back dimmed', async ({ page, request }) => {
  const dir = await openTrip(page, request);
  try {
    const tiles = page.locator('.gallery-tile');
    const count = await tiles.count();
    const first = await altOf(page, 0);
    const second = await altOf(page, 1);
    await expect(selectedImg(page)).toHaveAttribute('alt', first!);

    await page.keyboard.press('h');
    await expect.poll(() => photoInfo(dir)[first!]).toEqual({ hidden: true });
    await expect(page.locator(`.gallery-tile img[alt="${first}"]`)).toHaveCount(0);
    await expect(selectedImg(page)).toHaveAttribute('alt', second!);

    await page.getByRole('combobox', { name: 'Hidden' }).selectOption({ label: 'Show' });
    const back = page.locator('.gallery-tile', { has: page.locator(`img[alt="${first}"]`) });
    await expect(back).toHaveClass(/\bhidden\b/);
    await expect(back.getByLabel('Hidden')).toBeVisible();
    await expect(tiles).toHaveCount(count);
  } finally {
    removeTrip(dir);
  }
});

test('typing f, h and arrows in the description box changes only the text', async ({ page, request }) => {
  const dir = await openTrip(page, request);
  try {
    const first = await altOf(page, 0);
    await expect(selectedImg(page)).toHaveAttribute('alt', first!);
    const box = page.getByRole('textbox', { name: 'Description' });
    await box.click();
    await page.keyboard.type('fh');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('End');
    await page.keyboard.type('F');
    await expect(box).toHaveValue('fhF');
    await expect(selectedImg(page)).toHaveAttribute('alt', first!);
    await expect(page.locator('.gallery-tile.selected').getByLabel('Starred')).toHaveCount(0);
    await expect(page.locator('.gallery-tile.selected')).not.toHaveClass(/\bhidden\b/);
  } finally {
    removeTrip(dir);
  }
});

test('a stack badge unfolds and folds the stack', async ({ page, request }) => {
  const dir = await openTrip(page, request);
  try {
    const tiles = page.locator('.gallery-tile');
    const folded = await tiles.count();
    const show = page.getByRole('button', { name: /^Show \d+ similar photos$/ }).first();
    await expect(show).toBeVisible();
    const n = Number((await show.getAttribute('aria-label'))!.match(/\d+/)![0]);
    expect(n).toBeGreaterThanOrEqual(2);
    const selectedBefore = await selectedImg(page).getAttribute('alt');

    await show.click();
    await expect(tiles).toHaveCount(folded + n - 1);
    await expect(page.locator('.gallery-tile.stack-member')).toHaveCount(n - 1);
    // The badge opens the stack without selecting its photo.
    await expect(selectedImg(page)).toHaveAttribute('alt', selectedBefore!);

    await page.getByRole('button', { name: `Fold ${n} similar photos` }).click();
    await expect(tiles).toHaveCount(folded);
    await expect(page.locator('.gallery-tile.stack-member')).toHaveCount(0);
  } finally {
    removeTrip(dir);
  }
});

test('the hover preview no longer appears', async ({ page, request }) => {
  const dir = await openTrip(page, request);
  try {
    await page.locator('.gallery-tile').nth(1).hover();
    await page.waitForTimeout(600);
    await expect(page.locator('.hover-preview')).toHaveCount(0);
  } finally {
    removeTrip(dir);
  }
});

test('info sections fold and stay folded after reload', async ({ page, request }) => {
  const dir = await openTrip(page, request);
  try {
    await page.locator('.gallery-tile').first().click();
    const panel = page.getByRole('complementary', { name: 'Photo details' });
    const header = panel.getByRole('button', { name: 'Camera', exact: true });
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await page.reload();
    await page.getByRole('button', { name: dir }).click();
    await expect(page.locator('.gallery-tile').first()).toBeVisible({ timeout: 60_000 });
    await page.locator('.gallery-tile').first().click();
    await expect(panel.getByRole('button', { name: 'Camera', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await expect(panel.getByRole('button', { name: 'Photo', exact: true })).toHaveAttribute('aria-expanded', 'true');
  } finally {
    removeTrip(dir);
  }
});

test('histogram draws for the selected photo', async ({ page, request }) => {
  const dir = await openTrip(page, request);
  try {
    await page.locator('.gallery-tile').first().click();
    const section = page.locator('.gallery-section', { has: page.getByRole('button', { name: 'Histogram', exact: true }) });
    await expect(section.locator('svg path').first()).toHaveAttribute('d', /\S/);
    await expect(section).toContainText('Shadows clipped');
  } finally {
    removeTrip(dir);
  }
});

test('camera section says No camera details for a photo without EXIF', async ({ page, request }) => {
  const dir = await openTrip(page, request);
  try {
    // The undated PNG carries no EXIF at all; the JPEGs carry a make and model only.
    await page.getByLabel('Stack similar').uncheck();
    await page.locator('.gallery-tile[title="undated-scan.png"]').click();
    const panel = page.getByRole('complementary', { name: 'Photo details' });
    await expect(panel).toContainText('No camera details in this file');
    await page.locator('.gallery-tile[title="day3-01-cafe.jpg"]').click();
    await expect(panel).toContainText('Photobook Fixture');
    await expect(panel).not.toContainText('No camera details in this file');
  } finally {
    removeTrip(dir);
  }
});

test('right-click opens the menu with icons; Copy path puts the path on the clipboard', async ({ page, request, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const dir = await openTrip(page, request);
  try {
    await page.getByLabel('Stack similar').uncheck();
    const tile = page.locator('.gallery-tile').nth(2);
    const path = await tile.getAttribute('data-path');
    await tile.click({ button: 'right' });
    // Right-clicking an unselected tile selects it.
    await expect(tile).toHaveClass(/\bselected\b/);
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    const items = menu.getByRole('menuitem');
    await expect(items).toHaveText([/Edit/, /Copy to clipboard/, /Copy path to clipboard/, /Show in file explorer/, /Favourite/, /Hide/, /Delete/]);
    for (let i = 0; i < 7; i++) await expect(items.nth(i).locator('svg.icon')).toHaveCount(1);
    await expect(menu.locator('.ctx-sep')).toHaveCount(3);

    await menu.getByRole('menuitem', { name: /Copy path to clipboard/ }).click();
    await expect(menu).toHaveCount(0);
    await expect(page.locator('.toast', { hasText: 'Copied' }).first()).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(path);

    // Several selected: right-click one of them keeps the selection, and every path goes, in grid order.
    const first = page.locator('.gallery-tile').nth(0);
    await first.click();
    await page.locator('.gallery-tile').nth(1).click({ modifiers: ['Shift'] });
    const paths = [await first.getAttribute('data-path'), await page.locator('.gallery-tile').nth(1).getAttribute('data-path')];
    await page.locator('.gallery-tile').nth(1).click({ button: 'right' });
    await expect(page.locator('.gallery-tile.picked')).toHaveCount(2);
    await page.getByRole('menuitem', { name: /Copy path to clipboard/ }).click();
    // Windows' clipboard hands text back with CRLF line ends.
    await expect.poll(async () => (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')).toBe(paths.join('\n'));

    // A review key closes it and does its work: the selection moves on from the focused photo (the second).
    await first.click({ button: 'right' });
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.locator('.gallery-tile').nth(2)).toHaveClass(/\bselected\b/);

    // Esc closes it.
    await first.click({ button: 'right' });
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
  } finally {
    removeTrip(dir);
  }
});

test('desktop-only items are disabled in the browser', async ({ page, request }) => {
  const dir = await openTrip(page, request);
  try {
    await page.locator('.gallery-tile').first().click({ button: 'right' });
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: /Copy to clipboard/ })).toBeDisabled();
    await expect(menu.getByRole('menuitem', { name: /Show in file explorer/ })).toBeDisabled();
    await expect(menu.getByRole('menuitem', { name: /Delete/ })).toBeDisabled();
    await expect(menu.getByRole('menuitem', { name: /Copy path to clipboard/ })).toBeEnabled();
    await expect(menu.getByRole('menuitem', { name: /Favourite/ })).toBeEnabled();
    // A click outside closes it.
    await page.getByRole('region', { name: 'Preview' }).click({ position: { x: 5, y: 5 } });
    await expect(menu).toHaveCount(0);
    // Every photo is still there.
    expect(readdirSync(dir).filter(isSupported).length).toBe(readdirSync(FIXTURES).filter(isSupported).length);
  } finally {
    removeTrip(dir);
  }
});

test('Hide from the menu hides the photo', async ({ page, request }) => {
  const dir = await openTrip(page, request);
  try {
    const first = await altOf(page, 0);
    const second = await altOf(page, 1);
    await page.getByRole('region', { name: 'Preview' }).locator('img').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Hide/ }).click();
    await expect.poll(() => photoInfo(dir)[first!]).toEqual({ hidden: true });
    await expect(page.locator(`.gallery-tile img[alt="${first}"]`)).toHaveCount(0);
    await expect(selectedImg(page)).toHaveAttribute('alt', second!);
  } finally {
    removeTrip(dir);
  }
});

// ---- Map tab. Two photos get places far apart (Paris, Rome) and a description to filter on, so the
// map shows just their two markers. The tile server is blocked in every test: no test uses the network.
const PARIS = 'day1-02-street.jpg';
const ROME = 'day3-02-museum.jpg';
const MAP_SEED = {
  [PARIS]: { description: 'maptest', location: { lat: 48.8566, lon: 2.3522 } },
  [ROME]: { description: 'maptest', location: { lat: 41.9028, lon: 12.4964 } },
};

/** Abort every request for an OpenStreetMap tile; the list of those asked for. */
async function blockTiles(page: Page): Promise<string[]> {
  const asked: string[] = [];
  await page.route(/^https?:\/\/([a-z0-9-]+\.)*tile\.openstreetmap\.org\//, (route) => {
    asked.push(route.request().url());
    return route.abort('internetdisconnected');
  });
  return asked;
}

async function openMap(page: Page, request: APIRequestContext): Promise<{ dir: string; asked: string[] }> {
  const asked = await blockTiles(page);
  const dir = await openTrip(page, request, MAP_SEED);
  await page.getByLabel('Search descriptions and notes').fill('maptest');
  await expect(page.locator('.gallery-tile')).toHaveCount(2);
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  return { dir, asked };
}

const marker = (page: Page, name: string) => page.locator(`.gallery-map-marker img[alt="${name}"]`);

test('Map tab shows the consent prompt first', async ({ page, request }) => {
  const { dir, asked } = await openMap(page, request);
  try {
    const prompt = page.getByRole('region', { name: 'Online maps' });
    await expect(prompt).toContainText('The map is downloaded from OpenStreetMap over the internet. This shows OpenStreetMap roughly where you are looking. Load maps from the internet?');
    await expect(prompt.getByRole('button', { name: 'Load maps' })).toBeVisible();
    await expect(prompt.getByRole('button', { name: 'Not now' })).toBeVisible();
    // The grid is gone; nothing was asked of the tile server before the answer.
    await expect(page.locator('.gallery-tile')).toHaveCount(0);
    expect(asked).toEqual([]);
  } finally {
    removeTrip(dir);
  }
});

test('Not now shows markers without tiles', async ({ page, request }) => {
  const { dir, asked } = await openMap(page, request);
  try {
    await page.getByRole('button', { name: 'Not now' }).click();
    await expect(page.getByRole('region', { name: 'Online maps' })).toHaveCount(0);
    await expect(page.locator('.gallery-map-marker')).toHaveCount(2);
    await expect(marker(page, PARIS)).toHaveAttribute('src', /\/api\/gallery\/thumb\?.*size=s/);
    // Fetched only once the marker is drawn.
    await expect(marker(page, PARIS)).toHaveAttribute('loading', 'lazy');
    await expect(page.getByRole('button', { name: 'Map: offline' })).toBeVisible();
    await expect(page.locator('.leaflet-tile')).toHaveCount(0);
    // The answer is remembered: after a reload the map opens without asking.
    await page.reload();
    await page.getByRole('button', { name: dir }).click();
    await expect(page.locator('.gallery-tile').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Map', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Map: offline' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Online maps' })).toHaveCount(0);
    expect(asked).toEqual([]);
  } finally {
    removeTrip(dir);
  }
});

test('Load maps asks the tile server for tiles only; offline says so over the markers', async ({ page, request }) => {
  const { dir, asked } = await openMap(page, request);
  try {
    await page.getByRole('button', { name: 'Load maps' }).click();
    await expect(page.getByText('Map unavailable offline')).toBeVisible();
    await expect(page.locator('.gallery-map-marker')).toHaveCount(2);
    await expect(page.getByText('© OpenStreetMap contributors')).toBeVisible();
    expect(asked.length).toBeGreaterThan(0);
    for (const url of asked) expect(url).toMatch(/^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/);
    // Turned off again from the corner: no more tiles.
    await page.getByRole('button', { name: 'Map: online' }).click();
    await expect(page.getByRole('button', { name: 'Map: offline' })).toBeVisible();
    await expect(page.locator('.leaflet-tile')).toHaveCount(0);
    await expect(page.getByText('Map unavailable offline')).toHaveCount(0);
  } finally {
    removeTrip(dir);
  }
});

test('clicking a marker selects the photo and the preview shows it', async ({ page, request }) => {
  const { dir } = await openMap(page, request);
  try {
    await page.getByRole('button', { name: 'Not now' }).click();
    await marker(page, ROME).click();
    const preview = page.getByRole('region', { name: 'Preview' });
    await expect(preview.locator('img')).toHaveAttribute('alt', ROME);
    await expect(page.getByRole('complementary', { name: 'Photo details' })).toContainText(ROME);
    await expect(page.locator('.gallery-map-marker.selected img')).toHaveAttribute('alt', ROME);
    // The arrow keys still step through the photos in grid order.
    await page.keyboard.press('ArrowLeft');
    await expect(preview.locator('img')).toHaveAttribute('alt', PARIS);
    await expect(page.locator('.gallery-map-marker.selected img')).toHaveAttribute('alt', PARIS);
  } finally {
    removeTrip(dir);
  }
});

test('switching back to Grid keeps the selection', async ({ page, request }) => {
  const { dir } = await openMap(page, request);
  try {
    await page.getByRole('button', { name: 'Not now' }).click();
    await marker(page, ROME).click();
    await page.getByRole('button', { name: 'Grid', exact: true }).click();
    await expect(page.locator('.gallery-map-marker')).toHaveCount(0);
    await expect(selectedImg(page)).toHaveAttribute('alt', ROME);
    await expect(page.getByRole('region', { name: 'Preview' }).locator('img')).toHaveAttribute('alt', ROME);
  } finally {
    removeTrip(dir);
  }
});

test('the map counts the shown photos that have no location', async ({ page, request }) => {
  const { dir } = await openMap(page, request);
  try {
    await page.getByRole('button', { name: 'Not now' }).click();
    // Both shown photos have a place: no note.
    await expect(page.getByText(/no location/)).toHaveCount(0);
    await page.getByLabel('Search descriptions and notes').fill('');
    // The scan (PNG) has no GPS in it.
    await expect(page.getByText(/\d+ photos? (has|have) no location/)).toBeVisible();
  } finally {
    removeTrip(dir);
  }
});
test('on a wide window the preview fits inside its pane; the wheel zooms with a mini map; double-click resets, then opens the viewer', async ({ page, request }) => {
  await page.setViewportSize({ width: 2400, height: 700 });
  const dir = await openTrip(page, request);
  try {
    const first = await altOf(page, 0);
    const preview = page.getByRole('region', { name: 'Preview' });
    const stage = preview.locator('.gallery-preview-stage');
    const img = preview.locator('.gallery-preview-img');
    await expect(img).toHaveAttribute('alt', first!);
    const inside = async () => {
      const s = (await stage.boundingBox())!;
      const b = (await img.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(s.x - 1);
      expect(b.y).toBeGreaterThanOrEqual(s.y - 1);
      expect(b.x + b.width).toBeLessThanOrEqual(s.x + s.width + 1);
      expect(b.y + b.height).toBeLessThanOrEqual(s.y + s.height + 1);
      return b;
    };
    // The whole picture is in the pane, not just its top half.
    await expect(img).toBeVisible();
    await expect.poll(async () => {
      const s0 = await stage.boundingBox();
      const b0 = await img.boundingBox();
      return !!s0 && !!b0 && b0.height > 100 && b0.x >= s0.x - 1 && b0.y >= s0.y - 1 && b0.x + b0.width <= s0.x + s0.width + 1 && b0.y + b0.height <= s0.y + s0.height + 1;
    }).toBe(true);
    const fitted = await inside();
    await expect(page.locator('.gallery-minimap')).toHaveCount(0);

    // Wheel up over the picture zooms in: the mini map appears and the picture is larger than the stage.
    const s = (await stage.boundingBox())!;
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
    await page.mouse.wheel(0, -100);
    const minimap = page.locator('.gallery-minimap');
    await expect(minimap).toBeVisible();
    await expect.poll(async () => (await img.boundingBox())!.height).toBeGreaterThan(fitted.height * 1.1);
    const mm = (await minimap.boundingBox())!;
    expect(Math.max(mm.width, mm.height)).toBeCloseTo(160, 0);

    // Zoom in more so there is room to pan; dragging the picture moves it.
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -100);
    await expect.poll(async () => (await img.boundingBox())!.height).toBeGreaterThan(fitted.height * 2);
    const before = (await img.boundingBox())!;
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
    await page.mouse.down();
    await page.mouse.move(s.x + s.width / 2 + 60, s.y + s.height / 2 + 30, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => Math.round((await img.boundingBox())!.x - before.x)).not.toBe(0);
    // A click on the mini map moves the view (its rectangle moves).
    const rect = page.locator('.gallery-minimap-view');
    const rectBefore = (await rect.boundingBox())!;
    const m = (await minimap.boundingBox())!;
    await page.mouse.click(m.x + 3, m.y + 3);
    await expect.poll(async () => Math.round((await rect.boundingBox())!.x - rectBefore.x)).not.toBe(0);

    // Double-click resets to fit; the mini map is gone.
    await stage.dblclick({ position: { x: 20, y: 20 } });
    await expect(minimap).toHaveCount(0);
    await expect.poll(async () => Math.round((await img.boundingBox())!.height)).toBe(Math.round(fitted.height));
    await inside();

    // At fit, double-click opens the viewer as before.
    await stage.dblclick({ position: { x: 20, y: 20 } });
    await expect(page.getByRole('dialog', { name: 'Photo viewer' })).toBeVisible();
    await page.keyboard.press('Escape');
  } finally {
    removeTrip(dir);
  }
});

// ---- Edit mode: crop and rotate in the preview pane. Nothing is written until a save (a later step).
const box = async (page: Page, selector: string) => (await page.locator(selector).boundingBox())!;

test('E opens edit mode; R turns the crop box; a dragged corner and Done leave an unsaved edit on the tile and preview', async ({ page, request }) => {
  const dir = await openTrip(page, request);
  try {
    const first = await altOf(page, 0);
    const preview = page.getByRole('region', { name: 'Preview' });
    await expect(selectedImg(page)).toHaveAttribute('alt', first!);
    await page.keyboard.press('e');
    const done = preview.getByRole('button', { name: 'Done' });
    await expect(done).toBeVisible();
    await expect(preview.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(preview.getByRole('group', { name: 'Aspect ratio' }).getByRole('button', { name: 'Free' })).toHaveAttribute('aria-pressed', 'true');
    // The review keys are off: the arrows do not move the selection.
    await page.keyboard.press('ArrowRight');
    await expect(selectedImg(page)).toHaveAttribute('alt', first!);

    // R turns the photo 90 degrees: the crop box (the whole photo) turns from landscape to portrait or back.
    const crop = page.locator('.gallery-crop-box');
    // The frame shows once the picture has loaded (its shape is not known before).
    await expect(page.locator('.gallery-edit-frame')).toBeVisible();
    await expect.poll(async () => (await crop.boundingBox())?.width ?? 0).toBeGreaterThan(50);
    const before = await box(page, '.gallery-crop-box');
    await page.keyboard.press('r');
    await expect.poll(async () => {
      const b = (await crop.boundingBox())!;
      return Math.round((b.width / b.height) * 100);
    }).toBe(Math.round((before.height / before.width) * 100));

    // Drag the bottom-right corner in: the box gets smaller.
    const turned = await box(page, '.gallery-crop-box');
    const h = await box(page, '.gallery-crop-handle.se');
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2 - 60, h.y + h.height / 2 - 40, { steps: 5 });
    await page.mouse.up();
    const cropped = await box(page, '.gallery-crop-box');
    expect(cropped.width).toBeLessThan(turned.width - 40);
    expect(cropped.height).toBeLessThan(turned.height - 20);

    await done.click();
    await expect(done).toHaveCount(0);
    await expect(page.locator('.gallery-tile.selected .gallery-tile-unsaved')).toHaveCount(1);
    await expect(page.locator('.gallery-tile-unsaved')).toHaveCount(1);
    await expect(preview).toContainText('Edited · not saved');
    // The preview and the tile show the edit; the arrows work again.
    await expect(preview.locator('.gallery-preview-img.gallery-edited img')).toBeVisible();
    await expect(page.locator('.gallery-tile.selected .gallery-edited img')).toHaveCount(1);
    // The edited photo zooms like any other, with the mini map; double-click goes back to fit.
    const stage = preview.locator('.gallery-preview-stage');
    const s = (await stage.boundingBox())!;
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
    await page.mouse.wheel(0, -100);
    await expect(page.locator('.gallery-minimap .gallery-edited img')).toHaveCount(1);
    await stage.dblclick({ position: { x: 20, y: 20 } });
    await expect(page.locator('.gallery-minimap')).toHaveCount(0);
    await page.keyboard.press('ArrowRight');
    await expect(selectedImg(page)).not.toHaveAttribute('alt', first!);
    await expect(preview).not.toContainText('Edited · not saved');
    // Nothing was written.
    expect(photoInfo(dir)).toEqual({});
  } finally {
    removeTrip(dir);
  }
});

test('Esc and Cancel leave edits as they were; e typed in the description does not open edit mode; the slider keeps its arrows', async ({ page, request }) => {
  const dir = await openTrip(page, request);
  try {
    const first = await altOf(page, 0);
    const preview = page.getByRole('region', { name: 'Preview' });
    const done = preview.getByRole('button', { name: 'Done' });

    const description = page.getByRole('textbox', { name: 'Description' });
    await description.click();
    await page.keyboard.type('e');
    await expect(description).toHaveValue('e');
    await expect(done).toHaveCount(0);

    // The caption's Edit button opens it too; the slider's arrows move the slider only.
    await preview.getByRole('button', { name: 'Edit' }).click();
    await expect(done).toBeVisible();
    const slider = preview.getByRole('slider', { name: 'Straighten' });
    await slider.focus();
    await page.keyboard.press('ArrowRight');
    await expect(slider).toHaveValue('0.5');
    await expect(preview).toContainText('+0.5°');
    await expect(selectedImg(page)).toHaveAttribute('alt', first!);
    // Double-click puts it back to 0.
    await slider.dblclick();
    await expect(slider).toHaveValue('0');
    await page.keyboard.press('Escape');
    await expect(done).toHaveCount(0);
    await expect(page.locator('.gallery-tile-unsaved')).toHaveCount(0);
    await expect(preview).not.toContainText('Edited · not saved');

    // An unsaved edit (Square), then edit again and Cancel: it is still there.
    await page.keyboard.press('e');
    await expect(page.locator('.gallery-edit-frame')).toBeVisible();
    await preview.getByRole('button', { name: 'Square' }).click();
    const sq = await box(page, '.gallery-crop-box');
    expect(Math.abs(sq.width - sq.height)).toBeLessThan(2);
    await done.click();
    await expect(page.locator('.gallery-tile.selected .gallery-tile-unsaved')).toHaveCount(1);
    await page.keyboard.press('e');
    await page.keyboard.press('r');
    await preview.getByRole('button', { name: 'Cancel' }).click();
    await expect(done).toHaveCount(0);
    await expect(page.locator('.gallery-tile.selected .gallery-tile-unsaved')).toHaveCount(1);
    await expect(preview).toContainText('Edited · not saved');

    // Reset and Done: back to no edit, which is what is saved, so the unsaved edit goes.
    await page.keyboard.press('e');
    await preview.getByRole('button', { name: 'Reset' }).click();
    await done.click();
    await expect(done).toHaveCount(0);
    await expect(page.locator('.gallery-tile-unsaved')).toHaveCount(0);
    await expect(preview).not.toContainText('Edited · not saved');
    await expect.poll(() => photoInfo(dir)).toEqual({ [first!]: { description: 'e' } });
  } finally {
    removeTrip(dir);
  }
});

test('Edit in the right-click menu opens edit mode on that photo; a saved edit shows on the tile and is where editing starts', async ({ page, request }) => {
  const dir = await openTrip(page, request, { 'day1-02-street.jpg': { edit: { rotate: 90, straighten: 0, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } } } });
  try {
    await page.getByLabel('Stack similar').uncheck();
    const tile = page.locator('.gallery-tile[title="day1-02-street.jpg"]');
    // A saved edit (info-file mode) shows, with no unsaved dot.
    await expect(tile.locator('.gallery-edited img')).toHaveCount(1);
    await expect(tile.locator('.gallery-tile-unsaved')).toHaveCount(0);
    await tile.click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Edit/ }).click();
    const preview = page.getByRole('region', { name: 'Preview' });
    await expect(preview.getByRole('button', { name: 'Done' })).toBeVisible();
    // It starts from the saved edit: the crop box is half the frame each way.
    await expect(page.locator('.gallery-edit-frame')).toBeVisible();
    await expect.poll(async () => (await page.locator('.gallery-edit-frame').boundingBox())?.width ?? 0).toBeGreaterThan(50);
    const frame = await box(page, '.gallery-edit-frame');
    const crop = await box(page, '.gallery-crop-box');
    expect(crop.width / frame.width).toBeCloseTo(0.5, 1);
    expect(crop.height / frame.height).toBeCloseTo(0.5, 1);
    // Done without a change: nothing unsaved.
    await preview.getByRole('button', { name: 'Done' }).click();
    await expect(preview.getByRole('button', { name: 'Done' })).toHaveCount(0);
    await expect(tile.locator('.gallery-tile-unsaved')).toHaveCount(0);
    await expect(preview).not.toContainText('Edited · not saved');
  } finally {
    removeTrip(dir);
  }
});
