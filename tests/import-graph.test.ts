import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { crossings, importClosure } from '../scripts/import-graph';

const dirs: string[] = [];
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'import-graph-'));
  dirs.push(root);
  for (const [name, text] of Object.entries(files)) {
    const full = join(root, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return root;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('importClosure', () => {
  it('follows imports, re-exports, css, html scripts, import(), new URL() and index files; skips node_modules and bare specifiers', () => {
    const root = tree({
      'a.ts': "import { b } from './b';\nimport './c.css';\nimport('./lazy'); new Worker(new URL('./w.ts', import.meta.url)); import x from './pkg'; import y from 'react';",
      'b.ts': "export * from './d';",
      'd.ts': 'export const b = 1;',
      'c.css': 'body{}',
      'lazy.ts': 'export {};',
      'w.ts': 'export {};',
      'pkg/index.ts': 'export {};',
      'node_modules/z/index.js': 'export {};',
      'page.html': '<script type="module" src="./a.ts"></script>',
      'unrelated.ts': 'export {};',
    });
    expect([...importClosure(['page.html'], root)].sort()).toEqual([
      'a.ts', 'b.ts', 'c.css', 'd.ts', 'lazy.ts', 'page.html', 'pkg/index.ts', 'w.ts',
    ]);
  });
});

describe('crossings', () => {
  it('lists imports that leave a folder and its allowed folders', () => {
    const root = tree({
      'x/one.ts': "import { two } from '../y/two';\nimport './own';",
      'x/own.ts': 'export {};',
      'y/two.ts': 'export const two = 1;',
    });
    expect(crossings(root, [{ from: 'x', mayImport: [] }])).toEqual([{ file: 'x/one.ts', imports: 'y/two.ts' }]);
    expect(crossings(root, [{ from: 'x', mayImport: ['y'] }])).toEqual([]);
  });
});

describe('the gallery reaches no book code', () => {
  it('has no book modules in its closure', () => {
    const root = resolve(__dirname, '..');
    const closure = importClosure(
      ['photo-tool/server/main.ts', 'photo-tool/web/index.html', 'photo-tool/web/main.tsx', 'photo-tool/server/tagging/worker.ts'],
      root,
    );
    for (const f of ['photo-tool/server/main.ts', 'photo-tool/web/index.html', 'photo-tool/web/main.tsx', 'photo-tool/server/tagging/worker.ts']) expect(closure.has(f)).toBe(true);
    for (const f of ['book', 'templates', 'generator', 'index', 'model']) expect(closure.has(`src/core/${f}.ts`)).toBe(false);
  });
});
