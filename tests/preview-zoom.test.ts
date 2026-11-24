import { describe, expect, it } from 'vitest';
import { centreOn, clampPan, fitSize, fitView, visibleRect, zoomAt, MAX_ZOOM } from '../src/core/previewZoom';

const img = { w: 1600, h: 1067 };

describe('fitSize', () => {
  it('fits the height in a wide pane (the old bug: the picture was cropped)', () => {
    const s = fitSize(1600, 1067, 2000, 500);
    expect(s.h).toBeCloseTo(500, 6);
    expect(s.w).toBeCloseTo((1600 / 1067) * 500, 6);
  });
  it('fits the width in a tall pane, and never crops', () => {
    const s = fitSize(1600, 1067, 400, 900);
    expect(s.w).toBeCloseTo(400, 6);
    expect(s.h).toBeLessThanOrEqual(900);
  });
});

describe('fitView', () => {
  it('centres the fitted picture at zoom 1', () => {
    const pane = { w: 2000, h: 500 };
    const v = fitView(img, pane);
    const s = fitSize(img.w, img.h, pane.w, pane.h);
    expect(v.zoom).toBe(1);
    expect(v.x).toBeCloseTo((pane.w - s.w) / 2, 6);
    expect(v.y).toBeCloseTo(0, 6);
  });
});

describe('zoomAt', () => {
  const pane = { w: 800, h: 600 };
  it('keeps the picture point under the pointer fixed', () => {
    const v0 = zoomAt(fitView(img, pane), 2, 400, 300, img, pane);
    const fit = fitSize(img.w, img.h, pane.w, pane.h);
    const px = 430, py = 290;
    const u = (px - v0.x) / (fit.w * v0.zoom);
    const w = (py - v0.y) / (fit.h * v0.zoom);
    const v1 = zoomAt(v0, 1.2, px, py, img, pane);
    expect((px - v1.x) / (fit.w * v1.zoom)).toBeCloseTo(u, 6);
    expect((py - v1.y) / (fit.h * v1.zoom)).toBeCloseTo(w, 6);
  });
  it('caps the zoom at 8', () => {
    let v = fitView(img, pane);
    for (let i = 0; i < 40; i++) v = zoomAt(v, 1.2, 400, 300, img, pane);
    expect(v.zoom).toBe(MAX_ZOOM);
  });
  it('zooming out to 1 returns the fit view', () => {
    let v = zoomAt(fitView(img, pane), 3, 100, 100, img, pane);
    v = zoomAt(v, 1 / 10, 100, 100, img, pane);
    expect(v).toEqual(fitView(img, pane));
  });
});

describe('clampPan', () => {
  it('leaves no gap after the pane shrinks', () => {
    const big = { w: 1000, h: 800 };
    const v = zoomAt(fitView(img, big), 4, 1000, 800, img, big);
    const small = { w: 500, h: 400 };
    const c = clampPan(v, img, small);
    const s = fitSize(img.w, img.h, small.w, small.h);
    expect(c.x).toBeLessThanOrEqual(0);
    expect(c.y).toBeLessThanOrEqual(0);
    expect(c.x + s.w * c.zoom).toBeGreaterThanOrEqual(small.w - 1e-9);
    expect(c.y + s.h * c.zoom).toBeGreaterThanOrEqual(small.h - 1e-9);
  });
  it('centres an axis where the picture is smaller than the pane', () => {
    const pane = { w: 2000, h: 500 };
    const c = clampPan({ zoom: 2, x: -999, y: -999 }, img, pane);
    const s = fitSize(img.w, img.h, pane.w, pane.h);
    expect(c.x).toBeCloseTo((pane.w - s.w * 2) / 2, 6);
    expect(c.y).toBeLessThanOrEqual(0);
  });
});

describe('visibleRect and centreOn', () => {
  const pane = { w: 800, h: 600 };
  it('is the whole picture at fit', () => {
    expect(visibleRect(fitView(img, pane), img, pane)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
  it('shrinks with the zoom and follows centreOn', () => {
    const v = centreOn(zoomAt(fitView(img, pane), 4, 400, 300, img, pane), 0.25, 0.75, img, pane);
    const r = visibleRect(v, img, pane);
    expect(r.x + r.w / 2).toBeCloseTo(0.25, 6);
    expect(r.y + r.h / 2).toBeCloseTo(0.75, 6);
    expect(r.w).toBeLessThan(0.5);
  });
  it('clamps centreOn at the edge', () => {
    const v = centreOn(zoomAt(fitView(img, pane), 4, 400, 300, img, pane), 0, 0, img, pane);
    const r = visibleRect(v, img, pane);
    expect(r.x).toBeCloseTo(0, 6);
    expect(r.y).toBeCloseTo(0, 6);
  });
});
