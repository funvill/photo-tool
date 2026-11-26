// The one table of keys (#9): the ? overlay lists it, and the handlers act only on what it matches, so a
// key a handler acts on cannot be missing from the list.
import { describe, expect, it } from 'vitest';
import { keyHint, matchShortcut, shortcutsFor, SHORTCUTS, type KeyLike, type ShortcutPlace } from '../web/shortcuts';
import { viewerStep } from '../core/galleryViewer';

/** Every key worth trying: letters, digits, punctuation and the named keys, each with and without modifiers. */
const NAMED = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Enter', ' ', 'Escape', 'Tab', 'Delete', 'Backspace', 'F1', 'F2'];
const CHARS = [...'abcdefghijklmnopqrstuvwxyz'].flatMap((c) => [c, c.toUpperCase()]).concat([...'0123456789[]\\/?.,;\'-=`']);
const KEYS = [...NAMED, ...CHARS];
const MODS: Omit<KeyLike, 'key'>[] = [{}, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { ctrlKey: true, shiftKey: true }];
const PLACES: ShortcutPlace[] = ['grid', 'viewer', 'edit'];

describe('the shortcut table', () => {
  it('has the keys of every place, F1 and F2 among them', () => {
    const keys = (p: ShortcutPlace) => shortcutsFor(p).map((s) => s.keys.join(' or '));
    expect(keys('edit')).toEqual(expect.arrayContaining(['R', 'Enter', 'Esc', '\\', '?', 'F1', 'F2']));
    expect(keys('edit')).not.toContain('F');
    expect(keys('grid')).toEqual(expect.arrayContaining(['F', 'H', 'E', '[', ']', 'Delete', 'Ctrl+A', 'Ctrl+D', 'Ctrl+C', 'Ctrl+Z', 'Ctrl+O', '\\', '?', 'F1', 'F2']));
    expect(shortcutsFor('viewer').find((s) => s.id === 'details')).toMatchObject({ keys: ['I'], does: 'Show or hide details' });
    expect(shortcutsFor('grid').find((s) => s.keys.join() === 'F')!.does).toMatch(/^Favourite/);
  });

  it('leaves out what needs the desktop app in a plain browser', () => {
    const ids = shortcutsFor('grid', { desktop: false }).map((s) => s.id);
    expect(ids).not.toContain('delete');
    expect(ids).not.toContain('copy');
    expect(ids).not.toContain('about');
    expect(ids).toContain('favourite');
  });

  it('never has two rows of one place for the same key press', () => {
    for (const place of PLACES)
      for (const key of KEYS)
        for (const mods of MODS) {
          const e = { key, ...mods };
          const hits = SHORTCUTS.filter((s) => !s.menu && s.places.includes(place) && s.matches(e)).map((s) => s.id);
          expect(hits.length, `${place} ${JSON.stringify(e)}: ${hits.join(', ')}`).toBeLessThanOrEqual(1);
        }
  });

  it('every id is unique, and every row has keys and words', () => {
    expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(SHORTCUTS.length);
    for (const s of SHORTCUTS) {
      expect(s.keys.length).toBeGreaterThan(0);
      expect(s.does).not.toBe('');
      expect(s.places.length).toBeGreaterThan(0);
    }
  });

  it('matches by the key, not by the key code: ? is ?, whatever the layout; menu accelerators are the menu\'s', () => {
    expect(matchShortcut('grid', { key: '?', shiftKey: true })).toBe('shortcuts');
    expect(matchShortcut('grid', { key: '/', shiftKey: true })).toBeNull();
    expect(matchShortcut('grid', { key: 'F1' })).toBeNull();
    expect(matchShortcut('grid', { key: 'o', ctrlKey: true })).toBeNull();
    expect(matchShortcut('grid', { key: 'Delete', shiftKey: true })).toBeNull();
    expect(matchShortcut('grid', { key: 'c', metaKey: true })).toBe('copy');
    expect(matchShortcut('edit', { key: 'f' })).toBeNull();
    expect(matchShortcut('viewer', { key: 'S' })).toBe('viewer-favourite');
  });

  it('every key the viewer acts on is in the viewer\'s list', () => {
    for (const key of KEYS) {
      const step = viewerStep(5, 10, key);
      if (step.action || step.index !== 5) expect(matchShortcut('viewer', { key }), key).not.toBeNull();
    }
  });
});

describe('keyHint', () => {
  it("is the key the photo menu shows, from the same table", () => {
    expect(keyHint('edit')).toBe('E');
    expect(keyHint('copy')).toBe('Ctrl+C');
    expect(keyHint('delete')).toBe('Delete');
  });
});
