// The auto draft follows the starred photos (photoinfo.json), and Update from stars changes the draft in place.
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const FIXTURES = join(process.cwd(), 'fixtures', 'generated', 'trip');
const NAMES = ['day1-01-arrival.jpg', 'day1-02-street.jpg', 'day1-04-lunch.jpg', 'day1-06-dusk.jpg'];

test('draft from two starred photos, then update after starring a third', async ({ page }) => {
  // A private copy of a few fixtures, so no other test sees these stars.
  const dir = mkdtempSync(join(tmpdir(), 'photobook-stars-'));
  mkdirSync(dir, { recursive: true });
  for (const n of NAMES) copyFileSync(join(FIXTURES, n), join(dir, n));
  const info = join(dir, 'photoinfo.json');
  const write = (stars: string[]) => writeFileSync(info, JSON.stringify({ format: 'photoinfo/1', photos: Object.fromEntries(stars.map((n) => [n, { star: true }])) }));
  write([NAMES[0], NAMES[1]]);

  await page.goto('/');
  await page.getByRole('button', { name: 'New book' }).first().click();
  await page.getByPlaceholder('e.g. Japan, Spring 2026').fill('E2E Stars');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.locator('.book-title')).toHaveText('E2E Stars');

  await page.getByRole('button', { name: 'Choose a folder…' }).click();
  const path = page.getByLabel('Folder path');
  await path.fill(dir);
  await path.press('Enter');
  await page.getByRole('button', { name: 'Import this folder' }).click();
  await expect(page.getByText(/Imported 4 photos/)).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: 'Generate first draft' }).click();
  const panel = page.locator('.auto-collage');
  await expect(panel).toContainText('2 photos placed');
  await expect(panel.getByRole('button', { name: 'Update from stars' })).toBeVisible();

  // Star a third photo in the file; the editor polls every 3 s and notices within a few seconds.
  write([NAMES[0], NAMES[1], NAMES[2]]);
  await expect(page.getByRole('button', { name: /Favorites|★/ }).first()).toContainText('3', { timeout: 15_000 });
  await panel.getByRole('button', { name: 'Update from stars' }).click();
  await expect(page.getByTestId('update-summary')).toContainText('1 added');
});
