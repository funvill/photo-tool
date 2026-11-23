import { defineConfig } from '@playwright/test';

// Drives the real app (production build served by the local server) in the system Chrome.
// Uses a throwaway data directory so it never touches your books. The port and the folder can be
// moved (PHOTOBOOK_E2E_PORT, PHOTOBOOK_E2E_DATA_DIR) when something else is using them.
const PORT = Number(process.env.PHOTOBOOK_E2E_PORT ?? 5185);
const DATA_DIR = process.env.PHOTOBOOK_E2E_DATA_DIR ?? 'test-results/e2e-data';

// One command line that both cmd.exe and sh run: no `rm`, and no `NAME=value` in front (the
// variables go in `env` below). The folder is emptied by Node, which reads it from the environment.
const emptyDataDir = `node -e "require('node:fs').rmSync(process.env.PHOTOBOOK_DATA_DIR, { recursive: true, force: true })"`;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  // One at a time: the tests share one server, and the performance test's 500-photo import would
  // otherwise compete with the other tests' imports (and make their timings flaky).
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${PORT}`, channel: 'chrome', viewport: { width: 1440, height: 900 } },
  webServer: {
    command: `${emptyDataDir} && vite build && tsx src/server/main.ts`,
    env: { NODE_ENV: 'production', PHOTOBOOK_PORT: String(PORT), PHOTOBOOK_DATA_DIR: DATA_DIR },
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
