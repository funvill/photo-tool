import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chronological, groupSimilar, type BookDocument, type ImageElement, type PhotoAsset } from '../../core';
import { api, isBrowserBackend, thumbUrl } from '../api';
import { useEditor } from '../store';
import { ASSET_MIME } from './Canvas';
import { FolderPicker } from './FolderPicker';
import { Icon } from './Icon';
import { HoverPreview, formatTaken } from './HoverPreview';
import { estimateRemaining, formatRemaining } from '../eta';
import { CleanupDialog } from './CleanupDialog';
import { Shelf, tildePath } from './Shelf';

type Filter = 'all' | 'unused' | 'favorites' | 'hidden' | 'issues' | `link:${string}`;

export function Library() {
  const assets = useEditor((s) => s.assets);
  // Subscribe to which photos are used (a string key), not to the whole document.
  const usageKey = useEditor((s) => (s.doc ? usageKeyOf(s.doc) : ''));
  const job = useEditor((s) => s.importJob);
  const projectId = useEditor((s) => s.projectId)!;
  const links = useEditor((s) => s.links);
  const [filter, setFilter] = useState<Filter>('all');
  const [picker, setPicker] = useState<'import' | 'relink' | null>(null);
  const [cleanup, setCleanup] = useState(false);
  const previewId = useEditor((s) => s.previewAssetId);

  const usage = useMemo(() => parseUsage(usageKey), [usageKey]);
  const hover = useHoverPreview(assets);

  // Web version: after a browser restart, folders read in place need permission again.
  const [needAccess, setNeedAccess] = useState(0);
  useEffect(() => {
    if (!api.web) return;
    let live = true;
    void api.web.foldersNeedingAccess(projectId).then((n) => live && setNeedAccess(n), () => undefined);
    return () => {
      live = false;
    };
  }, [projectId, assets.length, links.length]);
  const allowAccess = async () => {
    await api.web!.requestFolderAccess(projectId);
    setNeedAccess(await api.web!.foldersNeedingAccess(projectId));
    await useEditor.getState().refreshAssets();
    await useEditor.getState().refreshLinks();
    void useEditor.getState().syncLinks({ force: true });
  };

  // Near-duplicate groups (same rule the generator uses), for the "similar" badge.
  const similarCount = useMemo(() => {
    const g = groupSimilar(assets);
    const sizes = new Map<string, number>();
    for (const id of g.values()) sizes.set(id, (sizes.get(id) ?? 0) + 1);
    return new Map(assets.map((a) => [a.id, sizes.get(g.get(a.id)!) ?? 1]));
  }, [assets]);

  const missing = assets.filter((a) => a.missing).length;
  const ordered = useMemo(() => chronological(assets), [assets]);
  const linkFilter = filter.startsWith('link:') ? links.find((l) => `link:${l.folder}` === filter) : undefined;
  const fromLink = useMemo(() => new Set(linkFilter?.assetIds ?? []), [linkFilter]);
  const visible = ordered.filter((a) => {
    if (filter.startsWith('link:')) return fromLink.has(a.id);
    if (filter === 'unused') return !usage.has(a.id) && !a.excluded;
    if (filter === 'favorites') return a.favorite;
    if (filter === 'hidden') return a.excluded;
    if (filter === 'issues') return a.missing || !!a.exactDuplicateOf;
    return true;
  });

  const counts = {
    all: assets.length,
    unused: assets.filter((a) => !usage.has(a.id) && !a.excluded).length,
    favorites: assets.filter((a) => a.favorite).length,
    hidden: assets.filter((a) => a.excluded).length,
    issues: assets.filter((a) => a.missing || a.exactDuplicateOf).length,
  };

  const running = job && (job.status === 'scanning' || job.status === 'running');

  return (
    <aside
      className="library"
      ref={hover.asideRef}
      // Photo files dropped from the file manager are only imported; placing them is up to the user.
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        const running = useEditor.getState().importJob;
        if (running && (running.status === 'scanning' || running.status === 'running')) return useEditor.getState().toast('error', 'An import is already running. Drop again when it finishes.');
        void useEditor.getState().importDropped([...e.dataTransfer.files]);
      }}
    >
      <div className="panel-head">
        <h2>Library</h2>
        <div className="row">
          {assets.length > 1 && (
            <button className="btn btn-small btn-ghost" onClick={() => setCleanup(true)} title="Review similar shots, blurry photos and duplicates">
              <Icon name="sparkle" /> Clean up
            </button>
          )}
          <button className="btn btn-small" onClick={() => setPicker('import')} disabled={!!running}>
            <Icon name="plus" /> Import
          </button>
        </div>
      </div>
      {job && (
        <div className="import-progress">
          <div className="import-progress-label">
            {job.status === 'scanning' ? 'Scanning folder…' : job.status === 'running' ? importLabel(job) : `Done — ${job.imported} new`}
          </div>
          <div className="bar">
            <div className="bar-fill" style={{ width: `${job.total ? (job.processed / job.total) * 100 : 5}%` }} />
          </div>
        </div>
      )}
      <Shelf />
      {needAccess > 0 && (
        <div className="notice">
          <span>Your browser needs permission again to read {needAccess === 1 ? 'your photo folder' : `${needAccess} photo folders`} (for export and linked folders).</span>
          <button className="btn btn-small" onClick={() => void allowAccess()}>Allow access</button>
        </div>
      )}
      {missing > 0 && (
        <div className="notice notice-error">
          {missing} original{missing > 1 ? 's' : ''} missing.{' '}
          <button className="link" onClick={() => setPicker('relink')}>Relink…</button>
        </div>
      )}
      <div className="filters">
        {(['all', 'unused', 'favorites', 'hidden', 'issues'] as const).map((f) => (
          <button key={f} className={`chip ${filter === f ? 'chip-on' : ''}`} onClick={() => setFilter(f)}>
            {f === 'favorites' ? '★' : f[0].toUpperCase() + f.slice(1)} <span className="chip-count">{counts[f]}</span>
          </button>
        ))}
      </div>
      {links.length > 0 && (
        <div className="filters filters-links">
          <span className="muted small">From</span>
          {links.map((l) => (
            <button
              key={l.folder}
              className={`chip ${filter === `link:${l.folder}` ? 'chip-on' : ''} ${l.exists ? '' : 'chip-missing'}`}
              title={l.exists ? `${tildePath(l.folder)} · kept in sync` : `Folder not found: ${tildePath(l.folder)}`}
              onClick={() => setFilter(filter === `link:${l.folder}` ? 'all' : `link:${l.folder}`)}
            >
              {l.name} <span className="chip-count">{l.assetIds.length}</span>
            </button>
          ))}
        </div>
      )}
      {assets.length === 0 && !running ? (
        <div className="empty">
          <p>No photos yet.</p>
          <p className="muted">
            {isBrowserBackend
              ? 'Import a folder of photos. Everything stays on this device, in this browser; nothing is uploaded.'
              : 'Link a folder from the Shelf above, or import any folder. Originals stay where they are; only thumbnails are created, on this computer.'}
          </p>
          <button className="btn" onClick={() => setPicker('import')}>Choose a folder…</button>
        </div>
      ) : (
        <div className="grid" onScroll={hover.hide}>
          {visible.map((a) => (
            <Tile key={a.id} asset={a} used={usage.get(a.id) ?? 0} similar={similarCount.get(a.id) ?? 1} previewed={a.id === previewId} onHoverStart={hover.start} onHoverEnd={hover.hide} />
          ))}
          {visible.length === 0 && <p className="muted pad">Nothing here.</p>}
        </div>
      )}
      <PreviewPane usage={usage} />
      {hover.shown && <HoverPreview asset={hover.shown.asset} left={hover.shown.left} />}
      {cleanup && <CleanupDialog usage={usage} onClose={() => setCleanup(false)} />}
      {picker && (
        <FolderPicker
          title={picker === 'import' ? 'Import photos from a folder' : 'Find missing originals'}
          action={picker === 'import' ? 'Import this folder' : 'Search this folder'}
          offerLink={picker === 'import'}
          onCancel={() => setPicker(null)}
          onChoose={async (folder, link) => {
            setPicker(null);
            if (picker === 'import') await useEditor.getState().startImport(folder, { link });
            else {
              const r = await api.relink(projectId, folder);
              await useEditor.getState().refreshAssets();
              useEditor.getState().toast(r.stillMissing ? 'error' : 'success', `Relinked ${r.relinked}. ${r.stillMissing ? `${r.stillMissing} still missing.` : 'All originals found.'}`);
            }
          }}
        />
      )}
    </aside>
  );
}

/**
 * "assetId:count|…" for every photo placed in the book. Moving or cropping a photo changes the
 * document on every pointer move but not this key, so the library doesn't re-render during drags.
 */
function usageKeyOf(doc: BookDocument): string {
  const m = new Map<string, number>();
  const surfaces = doc.cover ? [doc.cover, ...doc.spreads] : doc.spreads;
  for (const s of surfaces) {
    for (const e of s.elements) if (e.type === 'image' && e.assetId) m.set(e.assetId, (m.get(e.assetId) ?? 0) + 1);
    if (s.backgroundImage) m.set(s.backgroundImage.assetId, (m.get(s.backgroundImage.assetId) ?? 0) + 1);
  }
  return [...m].map(([k, v]) => `${k}:${v}`).sort().join('|');
}

function parseUsage(key: string): Map<string, number> {
  return new Map(key ? key.split('|').map((kv) => { const [k, v] = kv.split(':'); return [k, Number(v)] as [string, number]; }) : []);
}

/** Larger view of the clicked (or selected) photo, with its details and quick actions. */
function PreviewPane({ usage }: { usage: Map<string, number> }) {
  const id = useEditor((s) => s.previewAssetId);
  const asset = useEditor((s) => (id ? s.assetMap.get(id) : undefined));
  const patch = useEditor((s) => s.patchAsset);
  const [open, setOpen] = useState(true);
  const used = asset ? usage.get(asset.id) ?? 0 : 0;
  const showInBook = () => {
    const st = useEditor.getState();
    if (!st.doc || !asset) return;
    const surfaces = [...(st.doc.cover ? [{ s: st.doc.cover, i: -1 }] : []), ...st.doc.spreads.map((s, i) => ({ s, i }))];
    const hit = surfaces.find(({ s }) => s.elements.some((e) => e.type === 'image' && e.assetId === asset.id));
    if (!hit) return;
    st.goToSpread(hit.i);
    const el = hit.s.elements.find((e) => e.type === 'image' && e.assetId === asset.id)!;
    st.select({ spreadId: hit.s.id, elementId: el.id });
  };
  return (
    <div className={`preview-pane ${open ? '' : 'closed'}`}>
      <button className="preview-head" onClick={() => setOpen(!open)}>
        <span>Preview</span>
        <Icon name="down" size={12} />
      </button>
      {open && (
        asset ? (
          <div className="preview-body">
            <div className={`preview-img ${asset.analysis?.transparent ? 'checker' : ''}`} draggable={!asset.missing} onDragStart={(e) => {
              e.dataTransfer.setData(ASSET_MIME, asset.id);
              e.dataTransfer.effectAllowed = 'copy';
            }}>
              <img src={thumbUrl(asset.id, 'm')} alt={asset.fileName} draggable={false} />
            </div>
            <div className="preview-meta">
              <strong className="ellipsis" title={asset.fileName}>{asset.fileName}</strong>
              <span className="muted small">{asset.capturedAt ? formatTaken(asset.capturedAt) : 'No capture date'}</span>
              <span className="muted small">{asset.widthPx} × {asset.heightPx} · {((asset.widthPx * asset.heightPx) / 1e6).toFixed(1)} MP{asset.missing ? ' · original missing' : ''}</span>
              {asset.people && asset.people.length > 0 && <span className="muted small">{asset.people.join(', ')}</span>}
              {asset.description && <span className="small preview-description">{asset.description}</span>}
            </div>
            <div className="row preview-actions">
              <button className={`icon-btn ${asset.favorite ? 'on' : ''}`} title={asset.favorite ? 'Unfavourite' : 'Favourite: always included in drafts'} onClick={() => patch(asset.id, { favorite: !asset.favorite })}><Icon name="star" /></button>
              <button className={`icon-btn ${asset.excluded ? 'on' : ''}`} title={asset.excluded ? 'Include in drafts' : 'Hide from drafts'} onClick={() => patch(asset.id, { excluded: !asset.excluded })}><Icon name={asset.excluded ? 'eye-off' : 'eye'} /></button>
              {used > 0 ? <button className="link small" onClick={showInBook}>In book{used > 1 ? ` ×${used}` : ''} — show</button> : <span className="muted small">Not in book · drag onto a page</span>}
            </div>
          </div>
        ) : (
          <p className="muted small preview-empty">Click a photo to preview it here. Drag photos onto a frame to replace, or onto empty space to add.</p>
        )
      )}
    </div>
  );
}

const Tile = memo(function Tile({ asset, used, similar, previewed, onHoverStart, onHoverEnd }: { asset: PhotoAsset; used: number; similar: number; previewed: boolean; onHoverStart: (id: string) => void; onHoverEnd: () => void }) {
  const patch = useEditor((s) => s.patchAsset);
  return (
    <div
      className={`tile ${asset.excluded ? 'tile-hidden' : ''} ${used ? 'tile-used' : ''} ${previewed ? 'tile-previewed' : ''} ${asset.analysis?.transparent ? 'checker tile-cutout' : ''}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('.tile-actions')) return;
        useEditor.setState({ previewAssetId: asset.id });
      }}
      draggable={!asset.missing}
      onPointerEnter={(e) => e.pointerType === 'mouse' && onHoverStart(asset.id)}
      onPointerLeave={onHoverEnd}
      onDragStart={(e) => {
        onHoverEnd();
        e.dataTransfer.setData(ASSET_MIME, asset.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
    >
      <img src={thumbUrl(asset.id)} alt={asset.fileName} loading="lazy" decoding="async" draggable={false} />
      <div className="tile-badges">
        {used > 0 && <span className="badge badge-used">{used > 1 ? `×${used}` : 'In book'}</span>}
        {asset.exactDuplicateOf && <span className="badge badge-warn">Duplicate</span>}
        {asset.analysis?.transparent && <span className="badge" title="Has transparency: whatever is behind it shows through">Cutout</span>}
        {!asset.exactDuplicateOf && similar > 1 && <span className="badge">Similar ×{similar}</span>}
        {asset.missing && <span className="badge badge-error">Missing</span>}
      </div>
      <div className="tile-actions">
        <button className={`icon-btn ${asset.favorite ? 'on' : ''}`} title={asset.favorite ? 'Unfavourite' : 'Favourite: always included in drafts'} onClick={() => patch(asset.id, { favorite: !asset.favorite })}>
          <Icon name="star" />
        </button>
        <button className={`icon-btn ${asset.excluded ? 'on' : ''}`} title={asset.excluded ? 'Include in drafts' : 'Hide from drafts'} onClick={() => patch(asset.id, { excluded: !asset.excluded })}>
          <Icon name={asset.excluded ? 'eye-off' : 'eye'} />
        </button>
      </div>
    </div>
  );
});

function importLabel(job: { processed: number; total: number; startedAt: string }): string {
  const base = `Importing ${job.processed} / ${job.total}`;
  const left = estimateRemaining(job.processed, job.total, Date.parse(job.startedAt), Date.now());
  return left === null ? base : `${base} · ${formatRemaining(left)}`;
}

const HOVER_DELAY_MS = 400;

/**
 * Rest the pointer on a tile for a moment and a large preview opens beside the library. It closes
 * when the pointer leaves, a drag starts, the list scrolls or Esc is pressed, and never opens mid-drag.
 */
function useHoverPreview(assets: PhotoAsset[]) {
  const asideRef = useRef<HTMLElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const dragging = useRef(false);
  const [shown, setShown] = useState<{ asset: PhotoAsset; left: number } | null>(null);
  const assetsRef = useRef(assets);
  assetsRef.current = assets;

  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setShown(null);
  }, []);
  const start = useCallback((id: string) => {
    window.clearTimeout(timer.current);
    if (dragging.current) return;
    timer.current = window.setTimeout(() => {
      const asset = assetsRef.current.find((a) => a.id === id);
      const el = asideRef.current;
      // Not on phones: the library is full width there and there is no room beside it.
      if (!asset || !el || dragging.current || window.matchMedia('(max-width: 700px)').matches) return;
      setShown({ asset, left: el.getBoundingClientRect().right });
    }, HOVER_DELAY_MS);
  }, []);

  useEffect(() => {
    const onDragStart = () => { dragging.current = true; hide(); };
    const onDragEnd = () => { dragging.current = false; };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    window.addEventListener('dragstart', onDragStart, true);
    window.addEventListener('dragend', onDragEnd, true);
    window.addEventListener('drop', onDragEnd, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('dragstart', onDragStart, true);
      window.removeEventListener('dragend', onDragEnd, true);
      window.removeEventListener('drop', onDragEnd, true);
      window.removeEventListener('keydown', onKey);
      window.clearTimeout(timer.current);
    };
  }, [hide]);

  return { asideRef, shown, start, hide };
}

export type { BookDocument, ImageElement };
