import { defineConfig } from '@playwright/test';

// Drives the real app (production build served by the local server) in the system Chrome.
// Uses a throwaway data directory so it never touches your books. The port and the folder can be
// moved (PHOTOBOOK_E2E_PORT, PHOTOBOOK_E2E_DATA_DIR) when something else is using them.
const PORT = Number(process.env.PHOTOBOOK_E2E_PORT ?? 5185);
const DATA_DIR = process.env.PHOTOBOOK_E2E_DATA_DIR ?? 'test-results/e2e-data';
// Photo Tool (photo-tool/tests/e2e/gallery.spec.ts) has its own server, port and throwaway folders.
const PHOTO_TOOL_PORT = Number(process.env.PHOTO_TOOL_E2E_PORT ?? 5186);
const PHOTOINFO_DIR = process.env.PHOTOBOOK_E2E_PHOTOINFO_DIR ?? 'test-results/e2e-photoinfo';
const PHOTO_TOOL_DIR = 'test-results/e2e-photo-tool';
const PHOTO_TOOL_PHOTOINFO_DIR = 'test-results/e2e-photo-tool-photoinfo';

// One command line that both cmd.exe and sh run: no `rm`, and no `NAME=value` in front (the
// variables go in `env` below). The folder is emptied by Node, which reads it from the environment.
const emptyDir = (name: string) => `node -e "require('node:fs').rmSync(process.env.${name}, { recursive: true, force: true })"`;

export default defineConfig({
  testDir: 'photobook-editor/tests/e2e',
  timeout: 120_000,
  // One at a time: the tests share one server, and the performance test's 500-photo import would
  // otherwise compete with the other tests' imports (and make their timings flaky).
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${PORT}`, channel: 'chrome', viewport: { width: 1440, height: 900 } },
  projects: [
    { name: 'editor', testDir: 'photobook-editor/tests/e2e' },
    { name: 'photo-tool', testDir: 'photo-tool/tests/e2e', use: { baseURL: `http://127.0.0.1:${PHOTO_TOOL_PORT}` } },
  ],
  // Started one after the other, in this order. Each program builds its own page.
  webServer: [
    {
      command: `${emptyDir('PHOTOBOOK_DATA_DIR')} && ${emptyDir('PHOTOINFO_FALLBACK_DIR')} && vite build --config photobook-editor/vite.config.ts && tsx photobook-editor/server/main.ts`,
      env: { NODE_ENV: 'production', PHOTOBOOK_PORT: String(PORT), PHOTOBOOK_DATA_DIR: DATA_DIR, PHOTOINFO_FALLBACK_DIR: PHOTOINFO_DIR },
      url: `http://127.0.0.1:${PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `${emptyDir('PHOTO_TOOL_DATA_DIR')} && ${emptyDir('PHOTOINFO_FALLBACK_DIR')} && vite build --config photo-tool/vite.config.ts && tsx photo-tool/server/main.ts`,
      // Photo tagging with fake models served from memory (photo-tool/tests/support/fakeTagging.ts): never the network.
      env: { NODE_ENV: 'production', PHOTO_TOOL_PORT: String(PHOTO_TOOL_PORT), PHOTO_TOOL_DATA_DIR: PHOTO_TOOL_DIR, PHOTOINFO_FALLBACK_DIR: PHOTO_TOOL_PHOTOINFO_DIR, PHOTO_TOOL_FAKE_TAGGING: '1' },
      url: `http://127.0.0.1:${PHOTO_TOOL_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
