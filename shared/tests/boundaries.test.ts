// Folder rules for the program split. Each later task adds a rule here.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
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
    const main = readFileSync(resolve(root, 'src/gallery/web/main.tsx'), 'utf8');
    expect(main).toContain('shared/web/base.css');
    expect(main).toContain('shared/web/fonts.css');
    expect(main).not.toContain('web/styles.css');
  });
});
