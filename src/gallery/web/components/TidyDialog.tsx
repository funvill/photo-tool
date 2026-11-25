import { useEffect, useState } from 'react';
import { Modal } from '../../../../shared/web/components/Modal';
import { galleryApi, type OrphanedFolder } from '../api';
import { useGallery } from '../store';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * "Tidy photo info": lists the entries in photoinfo.json files whose photo is gone from the folder
 * (deleted or moved), and removes them all after one confirmation. Nothing is removed before that.
 */
export function TidyDialog() {
  const job = useGallery((s) => s.job);
  const root = useGallery((s) => s.root);
  const [found, setFound] = useState<OrphanedFolder[] | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => useGallery.getState().setTidyOpen(false);

  useEffect(() => {
    if (!job) return;
    let live = true;
    galleryApi.orphans(job).then(
      (f) => live && setFound(f),
      (e) => {
        if (!live) return;
        useGallery.getState().toast('error', message(e));
        close();
      },
    );
    return () => void (live = false);
  }, [job]);

  const total = found?.reduce((n, f) => n + f.fileNames.length, 0) ?? 0;
  // Folders are shown relative to the one that was opened.
  const label = (folder: string) => (root && folder.startsWith(root) && folder.length > root.length ? folder.slice(root.length).replace(/^[\\/]+/, '') : '(this folder)');

  const remove = async () => {
    if (!found) return;
    setBusy(true);
    let removed = 0;
    try {
      for (const f of found) removed += (await galleryApi.forget(f.folder, f.fileNames)).removed;
      useGallery.getState().toast('success', `Removed ${removed} ${removed === 1 ? 'entry' : 'entries'}.`);
      close();
    } catch (e) {
      useGallery.getState().toast('error', message(e));
      // Some folders may have been done: show what is left.
      if (job) await galleryApi.orphans(job).then(setFound, () => undefined);
    } finally {
      setBusy(false);
    }
    void useGallery.getState().refreshInfo();
  };

  return (
    <Modal title="Tidy photo info" onClose={close} wide>
      {found === null ? (
        <p className="muted">Looking…</p>
      ) : total === 0 ? (
        <p>Nothing to tidy: every entry in the photo info files belongs to a photo in the folder.</p>
      ) : (
        <>
          <p className="muted small">These entries are for photos that are no longer in their folder. Removing them only changes the photo info files; no photo is touched.</p>
          <div className="gallery-orphans">
            {found.map((f) => (
              <section key={f.folder}>
                <h3 className="small" title={f.folder}>{label(f.folder)}</h3>
                <ul>
                  {f.fileNames.map((n) => <li key={n}>{n}</li>)}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}
      <div className="modal-foot">
        <span />
        <div className="row">
          <button type="button" className="btn" onClick={close}>Cancel</button>
          {total > 0 && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void remove()}>
              Remove {total} {total === 1 ? 'entry' : 'entries'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
