// The on-device tagging model catalogue: every file pinned and checked, two choices per part, safe licences.
import { describe, expect, it } from 'vitest';
import { choicesFor, findModel, MODEL_CATALOGUE, modelBytes } from '../core/tagModels';

describe('tagging model catalogue', () => {
  it('every choice has a 40-hex revision, files with 64-hex sha256 and positive bytes', () => {
    expect(MODEL_CATALOGUE.length).toBeGreaterThan(0);
    for (const m of MODEL_CATALOGUE) {
      expect(m.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(m.files.length).toBeGreaterThan(0);
      for (const f of m.files) {
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(f.bytes).toBeGreaterThan(0);
        expect(f.path).not.toMatch(/^\/|\.\./);
      }
    }
  });

  it('ids are unique; each part has exactly one smaller and one larger choice; keywords choices have keywordThreshold and meaningThreshold in (0, 1)', () => {
    const ids = MODEL_CATALOGUE.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const part of ['describe', 'keywords'] as const) {
      const sizes = MODEL_CATALOGUE.filter((m) => m.part === part).map((m) => m.size).sort();
      expect(sizes).toEqual(['larger', 'smaller']);
    }
    for (const m of MODEL_CATALOGUE.filter((c) => c.part === 'keywords')) {
      for (const t of [m.keywordThreshold, m.meaningThreshold]) {
        expect(t).toBeGreaterThan(0);
        expect(t).toBeLessThan(1);
      }
    }
  });

  it('licences are MIT, Apache-2.0 or BSD-3-Clause; no repo under deepinsight/ or insightface', () => {
    for (const m of MODEL_CATALOGUE) {
      expect(['MIT', 'Apache-2.0', 'BSD-3-Clause']).toContain(m.licence);
      expect(m.repo.toLowerCase()).not.toMatch(/deepinsight\/|insightface/);
    }
  });

  it("modelBytes sums file sizes; choicesFor returns smaller first; findModel('nope') is undefined", () => {
    const m = MODEL_CATALOGUE[0];
    expect(modelBytes(m)).toBe(m.files.reduce((s, f) => s + f.bytes, 0));
    for (const part of ['describe', 'keywords'] as const) {
      expect(choicesFor(part).map((c) => c.size)).toEqual(['smaller', 'larger']);
    }
    expect(findModel(m.id)).toBe(m);
    expect(findModel('nope')).toBeUndefined();
  });
});
