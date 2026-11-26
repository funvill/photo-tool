import { configDefaults, defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';

// See vitest.slow-files.json for why these files are slow.
const slowTestFiles: string[] = JSON.parse(readFileSync(new URL('./vitest.slow-files.json', import.meta.url), 'utf8')).files;

// The everyday loop: every test file except the slow ones (vitest.slow-files.json).
// `npm run test:slow` runs those, and `npm test` runs both.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'shared/tests/**/*.test.ts', 'photo-tool/tests/**/*.test.ts', 'photobook-editor/tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...slowTestFiles],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
