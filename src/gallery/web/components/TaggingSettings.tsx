import { useCallback, useEffect, useState } from 'react';
import { galleryApi, type ModelChoice, type ModelsState } from '../api';

/** "0.2 MB", "277 MB", "1.3 GB". */
export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  const mb = n / 1e6;
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

const PARTS = [
  { part: 'describe', title: 'Descriptions and objects', note: 'A sentence about each photo, and the things in it.' },
  { part: 'keywords', title: 'Keywords and search by meaning', note: 'Keywords for each photo, and search that finds photos by what you mean.' },
] as const;

const bytesOf = (m: ModelChoice) => m.files.reduce((s, f) => s + f.bytes, 0);
const speed = (s: number) => `about ${s < 1 ? 'under 1' : Math.round(s)} s a photo`;

/**
 * Settings → Photo tagging: for each part, Off or one of its models. A model is downloaded from Hugging Face
 * only after the person says yes; it can be cancelled and removed. Everything else runs on this computer.
 */
export function TaggingSettings() {
  const [state, setState] = useState<ModelsState | null>(null);
  const [asking, setAsking] = useState<ModelChoice | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await galleryApi.models());
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => void load(), [load]);
  // While a download runs, its progress is read twice a second.
  const downloading = !!state?.downloading;
  useEffect(() => {
    if (!downloading) return;
    const t = setInterval(() => void load(), 500);
    return () => clearInterval(t);
  }, [downloading, load]);

  const act = async (f: () => Promise<unknown>) => {
    setProblem(null);
    try {
      await f();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
    await load();
  };

  if (!state) return <p className="muted small">{problem ?? 'Loading photo tagging…'}</p>;
  const installed = new Map(state.installed.map((i) => [i.id, i]));

  return (
    <div className="gallery-tagging-settings">
      <h3 className="gallery-settings-title">Photo tagging</h3>
      <p className="muted small">
        Runs on this computer. The models are downloaded from Hugging Face only when you ask, and nothing else leaves the computer.
      </p>
      {PARTS.map(({ part, title, note }) => {
        const choices = state.catalogue.filter((m) => m.part === part).sort((a, b) => (a.size === b.size ? 0 : a.size === 'smaller' ? -1 : 1));
        const chosen = state.settings[part];
        const choose = (id: string | null) => {
          // Shown at once; the server's answer (load) puts it right if it refuses.
          const settings = { ...state.settings, [part]: id };
          setState({ ...state, settings });
          return act(() => galleryApi.setTaggingSettings(settings));
        };
        return (
          <fieldset key={part} className="gallery-settings-group">
            <legend>{title}</legend>
            <span className="muted small">{note}</span>
            <label className="gallery-settings-option">
              <input type="radio" name={`tag-${part}`} checked={!chosen} onChange={() => void choose(null)} />
              <span>
                <strong>Off</strong>
              </span>
            </label>
            {choices.map((m) => {
              const inst = installed.get(m.id);
              const ok = !!inst?.ok;
              const isDownloading = state.downloading?.id === m.id;
              return (
                <div key={m.id} className={`gallery-settings-option gallery-model${ok ? '' : ' disabled'}`}>
                  <input id={`model-${m.id}`} type="radio" name={`tag-${part}`} checked={chosen === m.id} disabled={!ok} onChange={() => void choose(m.id)} />
                  <label htmlFor={`model-${m.id}`}>
                    <span>
                      <strong>{m.label}</strong> <span className="muted small">({m.size})</span>
                    </span>
                    <span className="muted small">
                      {formatBytes(bytesOf(m))} · {speed(m.secondsPerPhoto)} · {m.licence}
                    </span>
                  </label>
                  <span className="gallery-model-actions">
                    {isDownloading && state.downloading ? (
                      <>
                        <span
                          className="gallery-model-progress"
                          role="progressbar"
                          aria-label={`Downloading ${m.label}`}
                          aria-valuemin={0}
                          aria-valuemax={state.downloading.total}
                          aria-valuenow={state.downloading.received}
                        >
                          <span style={{ width: `${(100 * state.downloading.received) / Math.max(1, state.downloading.total)}%` }} />
                        </span>
                        <button type="button" className="btn btn-small" onClick={() => void act(() => galleryApi.cancelDownload())}>
                          Cancel
                        </button>
                      </>
                    ) : ok ? (
                      <button type="button" className="btn btn-small" aria-label={`Remove ${m.label}`} onClick={() => void act(() => galleryApi.removeModel(m.id))}>
                        Remove
                      </button>
                    ) : inst ? (
                      <button type="button" className="btn btn-small" aria-label={`Download ${m.label} again`} disabled={downloading} onClick={() => setAsking(m)}>
                        Not working · Download again
                      </button>
                    ) : (
                      <button type="button" className="btn btn-small" aria-label={`Download ${m.label}`} disabled={downloading} onClick={() => setAsking(m)}>
                        Download
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </fieldset>
        );
      })}
      {asking && (
        <div className="gallery-confirm" role="alertdialog" aria-label="Download a model">
          <span>
            Download {asking.label}, {formatBytes(bytesOf(asking))}, from Hugging Face?
          </span>
          <span className="gallery-confirm-buttons">
            <button type="button" className="btn" onClick={() => setAsking(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              autoFocus
              onClick={() => {
                const m = asking;
                setAsking(null);
                void act(() => galleryApi.downloadModel(m.id));
              }}
            >
              Download
            </button>
          </span>
        </div>
      )}
      {(problem || state.error) && (
        <p className="gallery-settings-error small" role="alert">
          {problem ?? state.error}
        </p>
      )}
    </div>
  );
}
