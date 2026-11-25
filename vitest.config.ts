import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'shared/tests/**/*.test.ts', 'photo-tool/tests/**/*.test.ts', 'photobook-editor/tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
