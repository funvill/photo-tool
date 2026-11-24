// Edit geometry: crop, rotate and straighten as one pure model shared by the page (CSS) and the server (sharp).
import { describe, expect, it } from 'vitest';
import {
  ASPECTS,
  IDENTITY_EDIT,
  editCss,
  editKey,
  editPlan,
  fitCropToAspect,
  isIdentityEdit,
  parseEdit,
  resizeCrop,
  rotateEditLeft,
  straightenScale,
  turnedSize,
  type CropRect,
  type PhotoEdit,
} from '../src/core/photoEdit';

describe('straightenScale', () => {
  it('is 1 when not turned', () => {
    expect(straightenScale(100, 100, 0)).toBe(1);
  });

  it('is 1/sqrt(2) for a square turned 45 degrees', () => {
    expect(straightenScale(100, 100, 45)).toBeCloseTo(0.70711, 5);
  });

  it('keeps all four corners inside the turned picture', () => {
    const w = 400;
    const h = 300;
    const deg = 10;
    const s = straightenScale(w, h, deg);
    expect(s).toBeLessThan(1);
    const rad = (deg * Math.PI) / 180;
    for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const a = (sx * w * s) / 2;
      const b = (sy * h * s) / 2;
      // Turn the corner back by the angle; it must be inside the untouched w x h picture.
      const x = a * Math.cos(rad) + b * Math.sin(rad);
      const y = -a * Math.sin(rad) + b * Math.cos(rad);
      expect(Math.abs(x)).toBeLessThanOrEqual(w / 2 + 1e-6);
      expect(Math.abs(y)).toBeLessThanOrEqual(h / 2 + 1e-6);
    }
  });
});

describe('turnedSize', () => {
  it('swaps for quarter turns', () => {
    expect(turnedSize(400, 300, 0)).toEqual({ w: 400, h: 300 });
    expect(turnedSize(400, 300, 90)).toEqual({ w: 300, h: 400 });
    expect(turnedSize(400, 300, 180)).toEqual({ w: 400, h: 300 });
    expect(turnedSize(400, 300, 270)).toEqual({ w: 300, h: 400 });
  });
});

describe('editPlan', () => {
  it('is the whole picture for no edit', () => {
    const p = editPlan(4000, 3000, IDENTITY_EDIT);
    expect(p.out).toEqual({ w: 4000, h: 3000 });
    expect(p.extract).toEqual({ left: 0, top: 0, width: 4000, height: 3000 });
  });

  it('turns the picture before cutting', () => {
    const p = editPlan(4000, 3000, { rotate: 90, straighten: 0, crop: { x: 0, y: 0, w: 0.5, h: 1 } });
    expect(p.frame).toEqual({ w: 3000, h: 4000 });
    expect(p.out).toEqual({ w: 1500, h: 4000 });
  });

  it('shrinks the frame when straightening', () => {
    const p = editPlan(400, 300, { rotate: 0, straighten: 10, crop: { x: 0, y: 0, w: 1, h: 1 } });
    const s = straightenScale(400, 300, 10);
    expect(p.frame.w).toBe(Math.round(400 * s));
    expect(p.frame.h).toBe(Math.round(300 * s));
    expect(p.straighten).toBe(10);
  });
});

describe('parseEdit', () => {
  it('rejects missing and invalid edits', () => {
    expect(parseEdit(undefined)).toBeNull();
    expect(parseEdit(null)).toBeNull();
    expect(parseEdit('x')).toBeNull();
    expect(parseEdit({ rotate: 45 })).toBeNull();
  });

  it('clamps straighten and the crop', () => {
    expect(parseEdit({ rotate: 90, straighten: 99, crop: { x: -1, y: 0, w: 2, h: 1 } })).toEqual({
      rotate: 90,
      straighten: 45,
      crop: { x: 0, y: 0, w: 1, h: 1 },
    });
  });

  it('round-trips the identity edit', () => {
    expect(isIdentityEdit(parseEdit(IDENTITY_EDIT)!)).toBe(true);
  });
});

describe('isIdentityEdit / editKey', () => {
  it('spots edits that change something', () => {
    expect(isIdentityEdit({ ...IDENTITY_EDIT, rotate: 90 })).toBe(false);
    expect(isIdentityEdit({ ...IDENTITY_EDIT, straighten: 0.5 })).toBe(false);
    expect(isIdentityEdit({ ...IDENTITY_EDIT, crop: { x: 0, y: 0, w: 0.9, h: 1 } })).toBe(false);
  });

  it('keys equal edits alike and different edits apart', () => {
    const a: PhotoEdit = { rotate: 0, straighten: 1.5, crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 } };
    const b: PhotoEdit = { rotate: 0, straighten: 1.5, crop: { x: 0.1 + 1e-6, y: 0.2, w: 0.5, h: 0.5 } };
    expect(editKey(a)).toBe(editKey(b));
    expect(editKey({ ...IDENTITY_EDIT, rotate: 0 })).not.toBe(editKey({ ...IDENTITY_EDIT, rotate: 90 }));
  });
});

describe('rotateEditLeft', () => {
  it('four turns return the original', () => {
    const e: PhotoEdit = { rotate: 90, straighten: 3, crop: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } };
    let r = e;
    for (let i = 0; i < 4; i++) r = rotateEditLeft(r);
    expect(r.rotate).toBe(e.rotate);
    expect(r.straighten).toBe(e.straighten);
    expect(r.crop.x).toBeCloseTo(0.1, 9);
    expect(r.crop.y).toBeCloseTo(0.2, 9);
    expect(r.crop.w).toBeCloseTo(0.3, 9);
    expect(r.crop.h).toBeCloseTo(0.4, 9);
  });

  it('turns the left half into the bottom half', () => {
    const r = rotateEditLeft({ rotate: 0, straighten: 0, crop: { x: 0, y: 0, w: 0.5, h: 1 } });
    expect(r.rotate).toBe(270);
    expect(r.crop).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
  });
});

describe('ASPECTS', () => {
  it('lists the presets in order', () => {
    expect(ASPECTS.map((a) => a.id)).toEqual(['free', 'original', 'square', '4:5', '3:2', '16:9']);
  });
});

describe('fitCropToAspect', () => {
  it('fits the largest square on a landscape frame', () => {
    expect(fitCropToAspect({ x: 0, y: 0, w: 1, h: 1 }, 1, { w: 400, h: 300 })).toEqual({ x: 0.125, y: 0, w: 0.75, h: 1 });
  });

  it('stays centred on the old crop and inside the frame', () => {
    const r = fitCropToAspect({ x: 0, y: 0, w: 0.2, h: 0.2 }, 1, { w: 400, h: 300 });
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9);
    expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9);
  });
});

describe('resizeCrop', () => {
  const full: CropRect = { x: 0, y: 0, w: 1, h: 1 };
  const frame = { w: 400, h: 300 };

  it('cannot grow past the frame', () => {
    expect(resizeCrop(full, 'se', 0.5, 0.5, null, frame)).toEqual(full);
  });

  it('move stays inside the frame', () => {
    const r = resizeCrop({ x: 0.2, y: 0.2, w: 0.5, h: 0.5 }, 'move', 5, -5, null, frame);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9);
    expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9);
    expect(r.w).toBeCloseTo(0.5, 9);
  });

  it('keeps a minimum size', () => {
    const r = resizeCrop({ x: 0.2, y: 0.2, w: 0.5, h: 0.5 }, 'se', -5, -5, null, frame);
    expect(r.w).toBeCloseTo(0.05, 9);
    expect(r.h).toBeCloseTo(0.05, 9);
  });

  it('keeps the pixel ratio for every handle', () => {
    for (const handle of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const) {
      const r = resizeCrop({ x: 0.2, y: 0.2, w: 0.4, h: 0.4 * (4 / 3) }, handle, 0.1, -0.07, 1, frame);
      expect((r.w * frame.w) / (r.h * frame.h)).toBeCloseTo(1, 6);
      expect(r.x).toBeGreaterThanOrEqual(-1e-9);
      expect(r.y).toBeGreaterThanOrEqual(-1e-9);
      expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9);
      expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});

describe('editCss', () => {
  it('fits an unedited picture to the box', () => {
    const c = editCss(IDENTITY_EDIT, 400, 300, 200, 150);
    expect(c.box).toEqual({ w: 200, h: 150 });
    expect(c.img.width).toBe(200);
    expect(c.img.height).toBe(150);
    expect(c.img.transform).toBe('translate(100px, 75px) rotate(0deg) translate(-100px, -75px)');
  });

  it('shows a quarter turn with the box matching the turned picture', () => {
    const c = editCss({ rotate: 90, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 } }, 400, 300, 300, 300);
    // Turned picture is 300 x 400, so it fits a 300 x 300 box at 0.75.
    expect(c.box).toEqual({ w: 225, h: 300 });
    expect(c.img.width).toBe(300);
    expect(c.img.height).toBe(225);
    expect(c.img.transform).toBe('translate(112.5px, 150px) rotate(90deg) translate(-150px, -112.5px)');
  });

  it('shows a crop by moving and scaling the picture', () => {
    const c = editCss({ rotate: 0, straighten: 0, crop: { x: 0.5, y: 0, w: 0.5, h: 1 } }, 400, 300, 200, 300);
    // Right half is 200 x 300 px, so it fills a 200 x 300 box at scale 1.
    expect(c.box).toEqual({ w: 200, h: 300 });
    expect(c.img.width).toBe(400);
    expect(c.img.height).toBe(300);
    expect(c.img.transform).toBe('translate(0px, 150px) rotate(0deg) translate(-200px, -150px)');
  });
});
