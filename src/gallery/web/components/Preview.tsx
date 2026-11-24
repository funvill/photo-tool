import { useEffect, useState, type MouseEvent } from 'react';
import { editKey, editPlan, isIdentityEdit, type PhotoEdit } from '../../../core/photoEdit';
import { fullUrl, thumbUrl, type GalleryItem } from '../api';
import { useShallow } from 'zustand/react/shallow';
import { editActions, selectStackPlace, shownEdit, useFilteredItems, useGallery } from '../store';
import { Icon } from '../../../web/components/Icon';
import { EditPane } from './EditPane';
import { EditedImage } from './EditedImage';
import { MiniMap } from './MiniMap';
import { usePreviewZoom } from './usePreviewZoom';

export interface PreviewProps {
  /** Double-click: open the photo in the full-screen viewer. */
  onOpen(path: string): void;
  /** Right-click on the photo: the photo menu. */
  onContextMenu?(path: string, e: MouseEvent): void;
}

/**
 * The selected photo, large (the 1600 px picture fitted to the pane, never cropped; the wheel zooms, a drag pans),
 * with its file name and what is special about it: favourite, hidden, its place in a stack, an edit not saved yet.
 * Shown with its edit (the unsaved one, else the saved one), or in edit mode. Empty when nothing shown is selected.
 */
export function Preview({ onOpen, onContextMenu }: PreviewProps) {
  // A photo folded into a stack can be selected too (a marker on the map): it is looked for among every shown photo.
  const filtered = useFilteredItems();
  const selected = useGallery((s) => s.selected);
  const item = selected === null ? undefined : filtered.find((i) => i.path === selected);
  // Its place in the stack, folded or not: the face is first, the other members follow it in the shown order.
  const stack = useGallery((s) => {
    const p = item ? selectStackPlace(s, item.path) : null;
    return p ? `${p.place} of ${p.size} in stack` : null;
  });
  const editing = useGallery((s) => item !== undefined && s.editing === item.path);
  // Its save is on its way: an edit started now would be lost when it lands.
  const beingSaved = useGallery((s) => item !== undefined && s.savingPaths.includes(item.path));
  const unsaved = useGallery((s) => item !== undefined && item.path in s.pendingEdits);
  const shown = useGallery((s) => (item ? shownEdit(s, item) : null));
  const edit = shown && !isIdentityEdit(shown) ? shown : null;

  return (
    <section className="gallery-preview" aria-label="Preview">
      {item && (
        <>
          {editing ? (
            <EditPane key={item.key} item={item} />
          ) : (
            // A new photo, or a new edit, is a new stage: it starts fitted.
            <PreviewStage key={`${item.key}:${edit ? editKey(edit) : ''}`} item={item} edit={edit} onOpen={onOpen} onContextMenu={onContextMenu} />
          )}
          <div className="gallery-preview-caption">
            <strong className="ellipsis" title={item.path}>{item.relDir ? `${item.relDir}/${item.fileName}` : item.fileName}</strong>
            {item.info.star === true && <span className="badge gallery-badge-fav">Favourite</span>}
            {item.info.hidden === true && <span className="badge">Hidden</span>}
            {stack && <span className="badge">{stack}</span>}
            {unsaved && <span className="badge gallery-badge-unsaved">Edited · not saved</span>}
            {!editing && (
              <span className="gallery-preview-actions">
                <SaveButtons item={item} />
                <button type="button" className="btn btn-small gallery-preview-edit" disabled={beingSaved} onClick={() => useGallery.getState().startEdit(item.path)} title={beingSaved ? 'Saving…' : 'Crop and rotate (E)'}>
                  <Icon name="crop" size={14} />
                  Edit
                </button>
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * The caption's save buttons: Save and Save as… for the photo's unsaved edit, Save all (N) while any photo
 * has one, and Revert to original for an edit saved in the info file (with nothing unsaved over it).
 */
function SaveButtons({ item }: { item: GalleryItem }) {
  const a = useGallery(useShallow((s) => editActions(s, item)));
  const saving = useGallery((s) => s.saving);
  const g = useGallery.getState;
  return (
    <>
      {a.save && (
        <button type="button" className="btn btn-small btn-primary" disabled={saving || !!a.saveBlocked} title={a.saveBlocked ?? a.saveTitle} onClick={() => void g().saveEdit(item.path)}>
          Save
        </button>
      )}
      {a.save && (
        <button type="button" className="btn btn-small" disabled={saving || !!a.saveAsBlocked} title={a.saveAsBlocked ?? 'Save the edited photo as a new file; this one stays as it is'} onClick={() => void g().saveEditAs(item.path)}>
          Save as…
        </button>
      )}
      {a.saveAll > 0 && (
        <button type="button" className="btn btn-small" disabled={saving} title="Save every photo's unsaved edit" onClick={() => void g().saveAllEdits()}>
          Save all ({a.saveAll})
        </button>
      )}
      {a.revert && (
        <button type="button" className="btn btn-small" disabled={saving} title="Remove the crop and rotation saved in photoinfo.json" onClick={() => void g().revertEdit(item.path)}>
          Revert to original
        </button>
      )}
    </>
  );
}

/**
 * The picture in its stage. The stage is measured and the picture placed by a transform, so it always fits
 * (a grid row that grew to the picture's height used to crop it). Zoomed in, the full-size picture is swapped
 * in once it is needed, and a mini map shows where the view is. An edited photo is zoomed the same way: the
 * edited result is what fits, zooms and pans.
 */
function PreviewStage({ item, edit, onOpen, onContextMenu }: { item: GalleryItem; edit: PhotoEdit | null } & PreviewProps) {
  const [small, setSmall] = useState(false);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [full, setFull] = useState(false);
  // What is shown: the 1600 px picture, or the edited result cut from it (in its pixels).
  const shape = natural && edit ? editPlan(natural.w, natural.h, edit).out : natural;
  const z = usePreviewZoom(shape);

  // Past the 1600 px picture's own detail: load the full picture, and swap it in when it has arrived.
  // The picture is always drawn at its fitted size and scaled, so the swap does not move the view.
  const needFull = z.view !== null && z.fit !== null && shape !== null && z.fit.w * z.view.zoom > shape.w;
  useEffect(() => {
    if (!needFull || full) return;
    const probe = new Image();
    probe.onload = () => setFull(true);
    probe.src = fullUrl(item.path, item.key);
    return () => {
      probe.onload = null;
    };
  }, [needFull, full, item.path, item.key]);

  const src = full ? fullUrl(item.path, item.key) : thumbUrl(item.key, small ? 's' : 'm');
  const v = z.view;
  const zoomedIn = v !== null && v.zoom > 1;
  const placed = v && z.fit ? { width: z.fit.w, height: z.fit.h, transform: `translate(${v.x}px, ${v.y}px) scale(${v.zoom})` } : { visibility: 'hidden' as const };
  return (
    <div
      className={`gallery-preview-stage${zoomedIn ? ' zoomed' : ''}`}
      ref={z.stageRef}
      {...z.handlers}
      onDoubleClick={() => (zoomedIn ? z.reset() : onOpen(item.path))}
      onContextMenu={(e) => onContextMenu?.(item.path, e)}
    >
      {edit ? (
        <EditedImage
          className="gallery-preview-img"
          src={src}
          alt={item.fileName}
          edit={edit}
          box={z.fit ?? { w: 0, h: 0 }}
          style={placed}
          // The shape comes from the 1600 px picture only: the full one is the same shape.
          onPicture={(s) => !full && setNatural(s)}
          onError={() => !full && setSmall(true)}
        />
      ) : (
        <img
          className="gallery-preview-img"
          src={src}
          alt={item.fileName}
          draggable={false}
          onLoad={(e) => {
            // The shape comes from the 1600 px picture only: the full one is the same shape.
            if (!full) setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
          }}
          onError={() => !full && setSmall(true)}
          style={placed}
        />
      )}
      {zoomedIn && shape && z.visible && <MiniMap itemKey={item.key} img={shape} edit={edit} visible={z.visible} onCentre={z.centre} />}
    </div>
  );
}
