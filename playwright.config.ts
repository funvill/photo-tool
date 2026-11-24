import { defineConfig } from '@playwright/test';

// Drives the real app (production build served by the local server) in the system Chrome.
// Uses a throwaway data directory so it never touches your books. The port and the folder can be
// moved (PHOTOBOOK_E2E_PORT, PHOTOBOOK_E2E_DATA_DIR) when something else is using them.
const PORT = Number(process.env.PHOTOBOOK_E2E_PORT ?? 5185);
const DATA_DIR = process.env.PHOTOBOOK_E2E_DATA_DIR ?? 'test-results/e2e-data';
// The gallery program (tests/e2e/gallery.spec.ts) has its own server, port and throwaway folder.
const GALLERY_PORT = Number(process.env.PHOTOBOOK_E2E_GALLERY_PORT ?? 5186);
const GALLERY_DIR = process.env.PHOTOBOOK_E2E_GALLERY_DIR ?? 'test-results/e2e-gallery';

// One command line that both cmd.exe and sh run: no `rm`, and no `NAME=value` in front (the
// variables go in `env` below). The folder is emptied by Node, which reads it from the environment.
const emptyDir = (name: string) => `node -e "require('node:fs').rmSync(process.env.${name}, { recursive: true, force: true })"`;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  // One at a time: the tests share one server, and the performance test's 500-photo import would
  // otherwise compete with the other tests' imports (and make their timings flaky).
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${PORT}`, channel: 'chrome', viewport: { width: 1440, height: 900 } },
  projects: [
    { name: 'editor', testIgnore: /gallery\.spec\.ts$/ },
    { name: 'gallery', testMatch: /gallery\.spec\.ts$/, use: { baseURL: `http://127.0.0.1:${GALLERY_PORT}` } },
  ],
  // Started one after the other, in this order: the editor's command builds dist/web (the gallery's
  // page included), so the gallery's server only has to start.
  webServer: [
    {
      command: `${emptyDir('PHOTOBOOK_DATA_DIR')} && vite build && tsx src/server/main.ts`,
      env: { NODE_ENV: 'production', PHOTOBOOK_PORT: String(PORT), PHOTOBOOK_DATA_DIR: DATA_DIR },
      url: `http://127.0.0.1:${PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `${emptyDir('PHOTOBOOK_GALLERY_DATA_DIR')} && tsx src/gallery/server/main.ts`,
      // The editor data folder (where photo info for read-only folders goes) is inside the throwaway one too.
      env: { NODE_ENV: 'production', PHOTOBOOK_GALLERY_PORT: String(GALLERY_PORT), PHOTOBOOK_GALLERY_DATA_DIR: GALLERY_DIR, PHOTOBOOK_DATA_DIR: `${GALLERY_DIR}/editor` },
      url: `http://127.0.0.1:${GALLERY_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
