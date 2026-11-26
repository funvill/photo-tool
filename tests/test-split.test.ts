import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const slowTestFiles: string[] = JSON.parse(readFileSync(resolve(__dirname, '../vitest.slow-files.json'), 'utf8')).files;

describe('the fast / slow test split', () => {
  it('lists only files that exist, so a rename cannot drop a test from both sets', () => {
    const missing = slowTestFiles.filter((f) => !existsSync(resolve(__dirname, '..', f)));
    expect(missing).toEqual([]);
  });
  it('lists each file once, as a test file', () => {
    expect(new Set(slowTestFiles).size).toBe(slowTestFiles.length);
    expect(slowTestFiles.every((f) => f.endsWith('.test.ts'))).toBe(true);
  });
});
