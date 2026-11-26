import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';

// See vitest.slow-files.json for why these files are slow.
const slowTestFiles: string[] = JSON.parse(readFileSync(new URL('./vitest.slow-files.json', import.meta.url), 'utf8')).files;

// Only the slow test files. Same timeouts as the everyday config.
export default defineConfig({
  test: {
    include: slowTestFiles,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
