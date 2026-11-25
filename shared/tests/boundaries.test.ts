// Folder rules for the program split. Each later task adds a rule here.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';

const root = resolve(__dirname, '../..');
// Loaded by a computed path: shared must not import scripts/, and the rule below would flag a static import.
const graphFile = resolve(root, 'scripts/import-graph.ts');
const loadGraph = () => import(/* @vite-ignore */ pathToFileURL(graphFile).href) as Promise<{
    crossings(root: string, rules: { from: string; mayImport: string[] }[]): { file: string; imports: string }[];
  }>;

describe('shared', () => {
  it('imports nothing outside shared', async () => {
    const { crossings } = await loadGraph();
    expect(crossings(root, [{ from: 'shared', mayImport: [] }])).toEqual([]);
  });

  it('is where the gallery page gets its styles from', () => {
    const main = readFileSync(resolve(root, 'photo-tool/web/main.tsx'), 'utf8');
    expect(main).toContain('shared/web/base.css');
    expect(main).toContain('shared/web/fonts.css');
    expect(main).not.toContain('web/styles.css');
  });
});

describe('photo-tool', () => {
  it('imports only shared', async () => {
    expect(existsSync(resolve(root, 'photo-tool/server/main.ts'))).toBe(true);
    const { crossings } = await loadGraph();
    expect(crossings(root, [{ from: 'photo-tool', mayImport: ['shared'] }])).toEqual([]);
  });

  describe('builds its own page', () => {
    beforeAll(() => {
      execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'photo-tool/vite.config.ts'], { cwd: root, stdio: 'pipe' });
    }, 120_000);

    it('photo-tool builds its own page', () => {
      const index = resolve(root, 'dist/photo-tool/web/index.html');
      expect(existsSync(index)).toBe(true);
      expect(readFileSync(index, 'utf8')).toMatch(/<script[^>]+src="[^"]*assets\/[^"]+\.js"/);
    });
  });
});

describe('photobook-editor', () => {
  it('imports only shared', async () => {
    expect(existsSync(resolve(root, 'photobook-editor/server/main.ts'))).toBe(true);
    const { crossings } = await loadGraph();
    expect(crossings(root, [{ from: 'photobook-editor', mayImport: ['shared'] }])).toEqual([]);
  });
});

describe('src', () => {
  it('is empty', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(resolve(dir, entry.name));
        else files.push(resolve(dir, entry.name));
      }
    };
    walk(resolve(root, 'src'));
    expect(files).toEqual([]);
  });
});
