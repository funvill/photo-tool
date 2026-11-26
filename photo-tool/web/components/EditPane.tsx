import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { Icon } from '../../../shared/web/components/Icon';
import {
  ASPECTS,
  IDENTITY_EDIT,
  NO_ADJUST,
  editCss,
  fitCropToAspect,
  flipEdit,
  isIdentityEdit,
  resizeCrop,
  rotateEditLeft,
  turnedSize,
  type CropHandle,
  type Adjust,
  type CropRect,
  type PhotoEdit,
} from '../../../shared/core/photoEdit';
import type { Size } from '../../core/previewZoom';
import { galleryApi, thumbUrl, type GalleryItem } from '../api';
import { shownEdit, useGallery } from '../store';
import { matchShortcut } from '../shortcuts';
import { EditedImage } from './EditedImage';

// Edit mode in the preview pane, as Google Photos does it: the whole photo, turned and straightened, with a
// crop box over it (drag a corner or an edge to resize, inside to move; outside is dimmed), and a toolbar
// under it. Esc cancels, Enter is Done, R turns the photo 90 degrees anticlockwise.

type AspectId = (typeof ASPECTS)[number]['id'];

/** Room kept round the picture inside the stage, so the handles on its edges can be grabbed. */
const MARGIN = 24;
const HANDLES: Exclude<CropHandle, 'move'>[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const HANDLE_NAMES: Record<Exclude<CropHandle, 'move'>, string> = {
  nw: 'top left', n: 'top', ne: 'top right', e: 'right', se: 'bottom right', s: 'bottom', sw: 'bottom left', w: 'left',
};
const FIXED: Partial<Record<AspectId, number>> = { square: 1, '4:5': 4 / 5, '3:2': 3 / 2, '16:9': 16 / 9 };
const COLOUR_SLIDERS: { key: keyof Adjust; label: string }[] = [
  { key: 'brightness', label: 'Brightness' },
  { key: 'contrast', label: 'Contrast' },
  { key: 'saturation', label: 'Saturation' },
  { key: 'warmth', label: 'Warmth' },
];

/** A mouse click (detail > 0; a key press gives 0) leaves no focus on the toolbar button it pressed. */
const blurClicked = (e: MouseEvent) => {
  if (e.detail > 0) (e.target as HTMLElement).closest('button')?.blur();
};

/**
 * Keys typed into a field (the description, say) are the field's own. The straighten slider keeps its arrows,
 * but Esc, Enter and R still act on it: it has no use for them.
 */
const TYPING = 'input:not([type="range"]), textarea, select, [contenteditable="true"], [role="dialog"]';
const inside = (e: KeyboardEvent, selector: string) => !!(e.target as HTMLElement | null)?.closest?.(selector);

/** The pixel ratio (width / height) the crop box keeps, or null for Free. Original is the turned photo's own shape. */
function aspectRatio(aspect: AspectId, flipped: boolean, frame: Size): number | null {
  if (aspect === 'free') return null;
  const r = aspect === 'original' ? frame.w / frame.h : FIXED[aspect]!;
  return flipped && r !== 1 ? 1 / r : r;
}

export function EditPane({ item }: { item: GalleryItem }) {
  // Starting point: the photo's unsaved edit, else its saved one, else none.
  const [draft, setDraft] = useState<PhotoEdit>(() => shownEdit(useGallery.getState(), item) ?? IDENTITY_EDIT);
  const [aspect, setAspect] = useState<AspectId>('free');
  const [flipped, setFlipped] = useState(false);
  const [pic, setPic] = useState<Size | null>(null);
  const [stage, setStage] = useState<Size>({ w: 0, h: 0 });
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStage((p) => (p.w === el.clientWidth && p.h === el.clientHeight ? p : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The whole frame (turned and straightened, nothing cut away), fitted in the stage.
  const whole: PhotoEdit = { ...draft, crop: IDENTITY_EDIT.crop };
  const room = { w: Math.max(0, stage.w - 2 * MARGIN), h: Math.max(0, stage.h - 2 * MARGIN) };
  const frameBox = pic && room.w > 0 && room.h > 0 ? editCss(whole, pic.w, pic.h, room.w, room.h).box : null;
  // The frame's shape is the turned photo's (straightening keeps it), known before the picture has loaded too.
  const turned = pic ? turnedSize(pic.w, pic.h, draft.rotate) : { w: 1, h: 1 };
  // \ or Before held: the photo with no edit at all, fitted in the same room.
  const original = useGallery((st) => st.showOriginal);
  const originalBox = pic && room.w > 0 && room.h > 0 ? editCss(IDENTITY_EDIT, pic.w, pic.h, room.w, room.h).box : null;

  // Kept current for the key and pointer handlers.
  const live = useRef({ draft, aspect, flipped, turned, frameBox });
  live.current = { draft, aspect, flipped, turned, frameBox };

  const done = () => {
    const d = live.current.draft;
    useGallery.getState().finishEdit(isIdentityEdit(d) ? null : d);
  };
  const cancel = () => useGallery.getState().cancelEdit();
  const rotate = () => {
    const { draft: d, aspect: a, flipped: f } = live.current;
    setDraft(rotateEditLeft(d));
    // The crop box turns with the photo, so a fixed shape turns too (Original follows the turned photo by itself).
    if (a !== 'free' && a !== 'original' && a !== 'square') setFlipped(!f);
  };
  const pickAspect = (a: AspectId, f: boolean) => {
    setAspect(a);
    setFlipped(f);
    const r = aspectRatio(a, f, live.current.turned);
    if (r !== null) setDraft((d) => ({ ...d, crop: fitCropToAspect(d.crop, r, live.current.turned) }));
  };
  const flip = () => setDraft((d) => flipEdit(d));
  const reset = () => {
    // Everything: the crop, the turns, the flip, and light and colour.
    setDraft(IDENTITY_EDIT);
    setAspect('free');
    setFlipped(false);
  };
  const setAdjust = (k: keyof Adjust, v: number) => setDraft((d) => ({ ...d, adjust: { ...(d.adjust ?? NO_ADJUST), [k]: v } }));
  // Auto: the sliders from the photo's own statistics (they can be moved after). A reply for a photo no longer edited is dropped.
  const [autoBusy, setAutoBusy] = useState(false);
  const auto = async () => {
    setAutoBusy(true);
    try {
      const a = await galleryApi.autoAdjust(item.path);
      if (useGallery.getState().editing === item.path) setDraft((d) => ({ ...d, adjust: a }));
    } catch (e) {
      useGallery.getState().toast('error', `Couldn't work out Auto: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAutoBusy(false);
    }
  };

  // The store keeps the edit in progress: selecting another photo now is Done with it.
  useEffect(() => {
    useGallery.getState().setEditDraft(isIdentityEdit(draft) ? null : draft);
  }, [draft]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The keyboard shortcuts list takes the keys while it is open (Esc there closes it, not the edit).
      if (e.defaultPrevented || useGallery.getState().shortcutsOpen || inside(e, TYPING)) return;
      // Edit mode's keys are the table's (shortcuts.ts); \ is useOriginalKey's.
      const id = matchShortcut('edit', e);
      if (id === 'edit-cancel') {
        e.preventDefault();
        cancel();
      } else if (id === 'edit-done') {
        // Enter on a toolbar button reached with the keyboard presses that button (one clicked with the
        // mouse lets go of the focus, below, so Enter is Done after it).
        if (inside(e, 'button')) return;
        e.preventDefault();
        if (!e.repeat) done();
      } else if (id === 'edit-rotate') {
        e.preventDefault();
        if (!e.repeat) rotate();
      } else if (id === 'shortcuts') {
        e.preventDefault();
        if (!e.repeat) useGallery.getState().toggleShortcuts();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // The handlers read live state through `live`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dragging a handle, or the box itself (move). Pointer capture keeps the drag when the pointer leaves it.
  const drag = useRef<{ id: number; handle: CropHandle; px: number; py: number; crop: CropRect } | null>(null);
  const onPointerDown = (handle: CropHandle) => (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, handle, px: e.clientX, py: e.clientY, crop: live.current.draft.crop };
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    const box = live.current.frameBox;
    if (!d || d.id !== e.pointerId || !box) return;
    const { aspect: a, flipped: f, turned: t } = live.current;
    const crop = resizeCrop(d.crop, d.handle, (e.clientX - d.px) / box.w, (e.clientY - d.py) / box.h, aspectRatio(a, f, t), t);
    setDraft((old) => ({ ...old, crop }));
  };
  const onPointerUp = (e: PointerEvent) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };
  const dragProps = (handle: CropHandle) => ({ onPointerDown: onPointerDown(handle), onPointerMove, onPointerUp, onPointerCancel: onPointerUp });

  const c = draft.crop;
  const swappable = aspect !== 'free' && aspect !== 'square' && !(aspect === 'original' && turned.w === turned.h);
  return (
    <div className="gallery-editpane" role="group" aria-label="Edit photo">
      <div className="gallery-edit-stage" ref={stageRef} onContextMenu={(e) => e.preventDefault()}>
        {/* While \ or Before is held, the original (no edit at all) takes the frame's place; the draft stays as it is. */}
        {original && originalBox ? (
          <div className="gallery-edit-frame gallery-edit-original" style={{ width: originalBox.w, height: originalBox.h, left: (stage.w - originalBox.w) / 2, top: (stage.h - originalBox.h) / 2 }}>
            <EditedImage src={thumbUrl(item.key, 'm')} alt={item.fileName} edit={IDENTITY_EDIT} box={originalBox} />
          </div>
        ) : (
          <div
            className="gallery-edit-frame"
            style={frameBox ? { width: frameBox.w, height: frameBox.h, left: (stage.w - frameBox.w) / 2, top: (stage.h - frameBox.h) / 2 } : { visibility: 'hidden' }}
          >
            <EditedImage src={thumbUrl(item.key, 'm')} alt={item.fileName} edit={whole} box={frameBox ?? { w: 0, h: 0 }} onPicture={(s) => setPic((p) => p ?? s)} />
            <div
              className="gallery-crop-box"
              aria-label="Crop"
              style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%` }}
              {...dragProps('move')}
            >
              {HANDLES.map((h) => (
                <div key={h} className={`gallery-crop-handle ${h}`} aria-label={`Resize from the ${HANDLE_NAMES[h]}`} {...dragProps(h)} />
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="gallery-edit-tools gallery-edit-colour" role="group" aria-label="Light and colour" onClick={blurClicked}>
        {COLOUR_SLIDERS.map(({ key, label }) => {
          const v = (draft.adjust ?? NO_ADJUST)[key];
          return (
            <label key={key} className="gallery-straighten row" title="Double-click to reset">
              <span>{label}</span>
              <input type="range" min={-100} max={100} step={1} value={v} aria-label={label} onChange={(e) => setAdjust(key, Number(e.currentTarget.value))} onDoubleClick={() => setAdjust(key, 0)} />
              <output className="gallery-straighten-value">{`${v > 0 ? '+' : ''}${v}`}</output>
            </label>
          );
        })}
        <button type="button" className="btn btn-small" onClick={() => void auto()} disabled={autoBusy} title="Set light and colour from the photo itself">
          Auto
        </button>
      </div>
      <div className="gallery-edit-tools" onClick={blurClicked}>
        {/* The shapes need the photo's own shape: they wait for the picture. */}
        <div className="seg seg-compact" role="group" aria-label="Aspect ratio">
          {ASPECTS.map((a) => (
            <button key={a.id} type="button" className={aspect === a.id ? 'on' : ''} aria-pressed={aspect === a.id} disabled={!pic} onClick={() => pickAspect(a.id, aspect === a.id ? flipped : false)}>
              {a.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label="Swap portrait and landscape"
          title="Swap portrait and landscape"
          disabled={!swappable || !pic}
          onClick={() => pickAspect(aspect, !flipped)}
        >
          <Icon name="swap" />
        </button>
        <button type="button" className="btn btn-small" onClick={rotate} title="Rotate 90° anticlockwise (R)">
          <span className="gallery-rotate-left">
            <Icon name="rotate" size={14} />
          </span>
          Rotate 90°
        </button>
        <button type="button" className="btn btn-small" onClick={flip} title="Flip horizontally (mirror left to right)">
          <Icon name="swap" size={14} />
          Flip
        </button>
        <label className="gallery-straighten row" title="Double-click to reset">
          <span>Straighten</span>
          <input
            type="range"
            min={-45}
            max={45}
            step={0.5}
            value={draft.straighten}
            aria-label="Straighten"
            onChange={(e) => {
              const v = Number(e.currentTarget.value);
              // The crop stays as fractions of the frame, which keeps its shape as it turns.
              setDraft((d) => ({ ...d, straighten: v }));
            }}
            onDoubleClick={() => setDraft((d) => ({ ...d, straighten: 0 }))}
          />
          <output className="gallery-straighten-value">{`${draft.straighten > 0 ? '+' : ''}${draft.straighten}°`}</output>
        </label>
        <span className="gallery-edit-spacer" />
        <button type="button" className="btn btn-small" onClick={reset}>
          Reset
        </button>
        <button type="button" className="btn btn-small" onClick={cancel} title="Esc">
          Cancel
        </button>
        <button type="button" className="btn btn-small btn-primary" onClick={done} title="Enter">
          Done
        </button>
      </div>
    </div>
  );
}
