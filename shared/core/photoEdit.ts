// Photo edits (crop, rotate, straighten) as one pure model. The server's sharp pipeline uses `editPlan`
// and the page uses `editCss`; both go through `straightenScale`, so what you see is what gets saved.
//
// Order of steps, on the upright photo (EXIF orientation already applied):
//   1. turn clockwise by `rotate`;
//   2. turn by `straighten` about the centre, then keep the largest centred rectangle of the step 1
//      aspect ratio that lies wholly inside the turned picture (the "frame");
//   3. cut out `crop`, given as fractions of the frame.

export type QuarterTurn = 0 | 90 | 180 | 270;

/** A rectangle as fractions (0 to 1) of whatever it sits on. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PhotoEdit {
  /** Clockwise quarter turns, in degrees. */
  rotate: QuarterTurn;
  /** Extra turn in degrees, clockwise, -45 to 45. */
  straighten: number;
  crop: CropRect;
}

export const IDENTITY_EDIT: PhotoEdit = { rotate: 0, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 } };

const MAX_STRAIGHTEN = 45;
/** Smallest crop `parseEdit` accepts, as a fraction. */
const MIN_PARSED = 0.01;
/** Smallest crop the handles can make, as a fraction. */
const MIN_CROP = 0.05;
const SAME = 1e-4;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isQuarterTurn = (v: unknown): v is QuarterTurn => v === 0 || v === 90 || v === 180 || v === 270;

/** Reads an edit from stored JSON. Null when missing or invalid; out-of-range numbers are clamped. */
export function parseEdit(raw: unknown): PhotoEdit | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isQuarterTurn(r.rotate)) return null;
  let straighten = 0;
  if (r.straighten !== undefined) {
    if (!isNum(r.straighten)) return null;
    straighten = clamp(r.straighten, -MAX_STRAIGHTEN, MAX_STRAIGHTEN);
  }
  let crop: CropRect = { ...IDENTITY_EDIT.crop };
  if (r.crop !== undefined) {
    const c = r.crop as Record<string, unknown> | null;
    if (!c || typeof c !== 'object' || !isNum(c.x) || !isNum(c.y) || !isNum(c.w) || !isNum(c.h)) return null;
    const w = clamp(c.w, MIN_PARSED, 1);
    const h = clamp(c.h, MIN_PARSED, 1);
    crop = { x: clamp(c.x, 0, 1 - w), y: clamp(c.y, 0, 1 - h), w, h };
  }
  return { rotate: r.rotate, straighten, crop };
}

/** True when the edit changes nothing (it is the same as having no edit at all). */
export function isIdentityEdit(e: PhotoEdit): boolean {
  return (
    e.rotate === 0 &&
    e.straighten === 0 &&
    Math.abs(e.crop.x) <= SAME &&
    Math.abs(e.crop.y) <= SAME &&
    Math.abs(e.crop.w - 1) <= SAME &&
    Math.abs(e.crop.h - 1) <= SAME
  );
}

/** A short stable string for an edit, so equal edits share a cache key. Numbers are rounded to 1e-4. */
export function editKey(e: PhotoEdit): string {
  const n = (v: number): number => Math.round(v * 1e4);
  const text = [e.rotate, n(e.straighten), n(e.crop.x), n(e.crop.y), n(e.crop.w), n(e.crop.h)].join(',');
  // FNV-1a, 32 bit.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * How much a w x h picture must shrink, once turned by `deg`, for the largest centred rectangle of the same
 * aspect ratio to fit wholly inside it (no empty corners). 1 when not turned.
 */
export function straightenScale(w: number, h: number, deg: number): number {
  const rad = (Math.abs(deg) * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const k = Math.min(w / (w * c + h * s), h / (w * s + h * c));
  return Math.min(1, k);
}

/** Size of a w x h picture after the clockwise quarter turn. */
export function turnedSize(w: number, h: number, rotate: QuarterTurn): { w: number; h: number } {
  return rotate === 90 || rotate === 270 ? { w: h, h: w } : { w, h };
}

/**
 * The steps in pixels, for an upright picture of w x h: turn by `rotate`, turn by `straighten` and shrink to
 * `frame`, cut `extract` out of the frame. `out` is the size of the result.
 */
export function editPlan(
  w: number,
  h: number,
  e: PhotoEdit,
): {
  rotate: QuarterTurn;
  straighten: number;
  frame: { w: number; h: number };
  extract: { left: number; top: number; width: number; height: number };
  out: { w: number; h: number };
} {
  const t = turnedSize(w, h, e.rotate);
  const k = straightenScale(t.w, t.h, e.straighten);
  const fw = Math.max(1, Math.round(t.w * k));
  const fh = Math.max(1, Math.round(t.h * k));
  const left = clamp(Math.round(e.crop.x * fw), 0, fw - 1);
  const top = clamp(Math.round(e.crop.y * fh), 0, fh - 1);
  const width = clamp(Math.round(e.crop.w * fw), 1, fw - left);
  const height = clamp(Math.round(e.crop.h * fh), 1, fh - top);
  return {
    rotate: e.rotate,
    straighten: e.straighten,
    frame: { w: fw, h: fh },
    extract: { left, top, width, height },
    out: { w: width, h: height },
  };
}

/** Turns the edit 90 degrees anticlockwise, keeping the same part of the picture cropped. */
export function rotateEditLeft(e: PhotoEdit): PhotoEdit {
  const { x, y, w, h } = e.crop;
  return {
    rotate: ((e.rotate + 270) % 360) as QuarterTurn,
    straighten: e.straighten,
    // A point (px, py) of the frame lands at (py, 1 - px) after the turn.
    crop: { x: y, y: 1 - x - w, w: h, h: w },
  };
}

export const ASPECTS: { id: 'free' | 'original' | 'square' | '4:5' | '3:2' | '16:9'; label: string }[] = [
  { id: 'free', label: 'Free' },
  { id: 'original', label: 'Original' },
  { id: 'square', label: 'Square' },
  { id: '4:5', label: '4:5' },
  { id: '3:2', label: '3:2' },
  { id: '16:9', label: '16:9' },
];

/** The crop's width over height in fractions, for a pixel ratio on this frame. */
const fractionRatio = (ratio: number, frame: { w: number; h: number }): number => (ratio * frame.h) / frame.w;

/** The largest rectangle of the pixel ratio `ratio` (width / height) that fits the frame, centred on the old crop. */
export function fitCropToAspect(crop: CropRect, ratio: number, frame: { w: number; h: number }): CropRect {
  const rf = fractionRatio(ratio, frame);
  const h = Math.min(1, 1 / rf);
  const w = h * rf;
  const cx = crop.x + crop.w / 2;
  const cy = crop.y + crop.h / 2;
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
}

export type CropHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'move';

/**
 * Drags a handle of the crop box by dx, dy (fractions of the frame). Stays inside the frame, no smaller than
 * 5%, and keeps the pixel ratio `ratio` (width / height) when one is given.
 */
export function resizeCrop(
  crop: CropRect,
  handle: CropHandle,
  dx: number,
  dy: number,
  ratio: number | null,
  frame: { w: number; h: number },
): CropRect {
  const { x, y, w, h } = crop;
  if (handle === 'move') {
    return { x: clamp(x + dx, 0, 1 - w), y: clamp(y + dy, 0, 1 - h), w, h };
  }
  const hasW = handle.includes('w');
  const hasE = handle.includes('e');
  const hasN = handle.includes('n');
  const hasS = handle.includes('s');

  if (ratio === null) {
    let left = x;
    let right = x + w;
    let top = y;
    let bottom = y + h;
    if (hasW) left = clamp(x + dx, 0, right - MIN_CROP);
    if (hasE) right = clamp(right + dx, left + MIN_CROP, 1);
    if (hasN) top = clamp(y + dy, 0, bottom - MIN_CROP);
    if (hasS) bottom = clamp(bottom + dy, top + MIN_CROP, 1);
    return { x: left, y: top, w: right - left, h: bottom - top };
  }

  const rf = fractionRatio(ratio, frame);
  const minW = Math.max(MIN_CROP, MIN_CROP * rf);
  const cx = x + w / 2;
  const cy = y + h / 2;

  if ((hasW || hasE) && (hasN || hasS)) {
    // Corner: the opposite corner stays put.
    const ax = hasW ? x + w : x;
    const ay = hasN ? y + h : y;
    const dirX = hasW ? -1 : 1;
    const dirY = hasN ? -1 : 1;
    const newW = Math.max(0, ((hasW ? x : x + w) + dx - ax) * dirX);
    const newH = Math.max(0, ((hasN ? y : y + h) + dy - ay) * dirY);
    const maxW = dirX > 0 ? 1 - ax : ax;
    const maxH = dirY > 0 ? 1 - ay : ay;
    const nw = Math.min(Math.max(Math.min(newW, newH * rf), minW), maxW, maxH * rf);
    const nh = nw / rf;
    return { x: dirX > 0 ? ax : ax - nw, y: dirY > 0 ? ay : ay - nh, w: nw, h: nh };
  }

  if (hasW || hasE) {
    // Side edge: the opposite edge stays put and the height follows, centred.
    const edgeX = hasW ? x + w : x;
    const newW = Math.max(0, hasW ? x + dx : x + w + dx);
    const target = hasW ? edgeX - clamp(newW, 0, edgeX) : clamp(newW, edgeX, 1) - edgeX;
    const room = hasW ? edgeX : 1 - edgeX;
    const nw = Math.min(Math.max(target, minW), room, 2 * Math.min(cy, 1 - cy) * rf);
    const nh = nw / rf;
    return { x: hasW ? edgeX - nw : edgeX, y: clamp(cy - nh / 2, 0, 1 - nh), w: nw, h: nh };
  }

  // Top or bottom edge: the opposite edge stays put and the width follows, centred.
  const edgeY = hasN ? y + h : y;
  const newH = Math.max(0, hasN ? y + dy : y + h + dy);
  const target = hasN ? edgeY - clamp(newH, 0, edgeY) : clamp(newH, edgeY, 1) - edgeY;
  const room = hasN ? edgeY : 1 - edgeY;
  const minH = minW / rf;
  const nh = Math.min(Math.max(target, minH), room, (2 * Math.min(cx, 1 - cx)) / rf);
  const nw = nh * rf;
  return { x: clamp(cx - nw / 2, 0, 1 - nw), y: hasN ? edgeY - nh : edgeY, w: nw, h: nh };
}

const round4 = (v: number): number => {
  const r = Math.round(v * 1e4) / 1e4;
  return r === 0 ? 0 : r; // no "-0"
};

/**
 * How to show the edited result fitted inside a boxW x boxH box. The returned box is overflow hidden; the
 * upright picture (picW x picH) goes inside it at `img.width` x `img.height` with `img.transform`
 * (transform-origin 0 0): move the picture's centre to where it sits in the frame, turned by rotate + straighten.
 */
export function editCss(
  e: PhotoEdit,
  picW: number,
  picH: number,
  boxW: number,
  boxH: number,
): { box: { w: number; h: number }; img: { width: number; height: number; transform: string } } {
  const t = turnedSize(picW, picH, e.rotate);
  const k = straightenScale(t.w, t.h, e.straighten);
  const fw = t.w * k;
  const fh = t.h * k;
  const outW = e.crop.w * fw;
  const outH = e.crop.h * fh;
  // Box pixels per frame pixel.
  const f = Math.min(boxW / outW, boxH / outH);
  // The frame is cut from the turned picture at full size (no shrinking), so the picture is drawn at f only.
  const width = picW * f;
  const height = picH * f;
  // Turning happens about the picture's centre, which is also the frame's centre, so the centre sits at
  // the frame's middle minus the crop's offset into the frame.
  const tx = (fw / 2 - e.crop.x * fw) * f;
  const ty = (fh / 2 - e.crop.y * fh) * f;
  const deg = e.rotate + e.straighten;
  return {
    box: { w: round4(outW * f), h: round4(outH * f) },
    img: {
      width: round4(width),
      height: round4(height),
      transform: `translate(${round4(tx)}px, ${round4(ty)}px) rotate(${round4(deg)}deg) translate(${round4(-width / 2)}px, ${round4(-height / 2)}px)`,
    },
  };
}

/** The format an edited photo is written in. */
export type EditFormat = 'jpeg' | 'png' | 'webp';

/** The format an edited photo is written in: its own, except HEIC, which is written as JPEG. */
export function editFormatFor(path: string): EditFormat {
  const ext = /\.[^./\\]*$/.exec(path)?.[0].toLowerCase();
  if (ext === '.png') return 'png';
  if (ext === '.webp') return 'webp';
  return 'jpeg';
}
