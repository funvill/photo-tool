// This repository is cut from the project it was forked from: nothing points there any more, and the
// web version that was published from there is gone. Old design docs are history and keep their links.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
// Built by joining, so this file never matches its own search.
const OLD_OWNER = ['jkw', '2lo'].join('');
const OLD_REPO = ['photobook', 'studio'].join('_');
const HISTORY = [':!docs/superpowers', ':!docs/plan.md', ':!docs/research.md', ':!docs/handoff.md', ':!docs/electron-plan.md', ':!package-lock.json'];

/** `git grep` for the old owner and repository; its exit status and what it found. */
function grepUpstream(): { status: number; found: string } {
  try {
    const found = execFileSync('git', ['grep', '-n', '-I', '-e', OLD_OWNER, '-e', OLD_REPO, '--', '.', ...HISTORY], { cwd: root, encoding: 'utf8' });
    return { status: 0, found };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { status: err.status, found: err.stdout };
  }
}

describe('cut from upstream', () => {
  it('names the old repository nowhere outside the history docs', () => {
    const { status, found } = grepUpstream();
    expect(found).toBe('');
    expect(status).toBe(1);
  });

  it('has no web version: no Pages workflow, no pages build', () => {
    expect(existsSync(resolve(root, '.github/workflows/pages.yml'))).toBe(false);
    expect(existsSync(resolve(root, 'docs/WEB_VERSION.md'))).toBe(false);
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { name: string; scripts: Record<string, string> };
    expect(pkg.scripts['build:pages']).toBeUndefined();
    expect(pkg.scripts['preview:pages']).toBeUndefined();
    expect(JSON.stringify(pkg.scripts)).not.toContain('--mode pages');
    expect(pkg.name).toBe('photo-tools');
  });

  it("the editor's Vite config has no pages mode", () => {
    const vite = readFileSync(resolve(root, 'photobook-editor/vite.config.ts'), 'utf8');
    expect(vite).not.toMatch(/mode === 'pages'|dist\/pages/);
  });
});
