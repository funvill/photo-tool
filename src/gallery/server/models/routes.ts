// /api/gallery/models and /api/gallery/tagging/settings: list, download (one at a time), cancel, remove, choose.
import type express from 'express';
import { MODEL_CATALOGUE, findModel, type ModelChoice, type TagPart } from '../../../core/tagModels';
import { downloadModel, type DownloadProgress } from './download';
import { installedModels, readTaggingSettings, removeModel, writeTaggingSettings, type TaggingSettings } from './store';

export interface ModelRoutesOptions {
  fetch?: typeof fetch;
  catalogue?: readonly ModelChoice[];
  /** Called after the settings change (chosen models, pause) or a model is removed. */
  onSettings?(s: TaggingSettings): void;
  /** Called after a download ends or a model is removed. */
  onModelsChanged?(): void;
}

export function modelRoutes(app: express.Express, dataDir: string, o: ModelRoutesOptions): { stop(): void } {
  const catalogue = o.catalogue ?? MODEL_CATALOGUE;
  let downloading: (DownloadProgress & { abort: AbortController }) | null = null;
  let error: string | null = null;

  const saveSettings = (s: TaggingSettings) => {
    writeTaggingSettings(dataDir, s);
    o.onSettings?.(s);
  };

  app.get('/api/gallery/models', (_req, res) => {
    res.json({
      catalogue,
      installed: installedModels(dataDir, catalogue),
      settings: readTaggingSettings(dataDir),
      downloading: downloading && { id: downloading.id, received: downloading.received, total: downloading.total },
      error,
    });
  });

  app.post('/api/gallery/models/download/cancel', (_req, res) => {
    downloading?.abort.abort();
    res.status(204).end();
  });

  app.post('/api/gallery/models/:id/download', (req, res) => {
    const m = findModel(req.params.id, catalogue);
    if (!m) return void res.status(404).json({ error: 'No such model.' });
    if (downloading) return void res.status(409).json({ error: 'Another model is downloading. Wait for it, or cancel it.' });
    const abort = new AbortController();
    const current = (downloading = { id: m.id, received: 0, total: m.files.reduce((s, f) => s + f.bytes, 0), abort });
    error = null;
    downloadModel(dataDir, m, {
      fetch: o.fetch,
      signal: abort.signal,
      onProgress: (p) => {
        current.received = p.received;
      },
    })
      .catch((e: unknown) => {
        if (!abort.signal.aborted) error = `Couldn't download ${m.label}: ${e instanceof Error ? e.message : String(e)}`;
      })
      .finally(() => {
        if (downloading === current) downloading = null;
        o.onModelsChanged?.();
      });
    res.status(202).json({ id: m.id });
  });

  app.delete('/api/gallery/models/:id', (req, res) => {
    const m = findModel(req.params.id, catalogue);
    if (!m) return void res.status(404).json({ error: 'No such model.' });
    if (downloading?.id === m.id) downloading.abort.abort();
    removeModel(dataDir, m.id);
    const s = readTaggingSettings(dataDir);
    if (s[m.part] === m.id) saveSettings({ ...s, [m.part]: null });
    o.onModelsChanged?.();
    res.status(204).end();
  });

  app.put('/api/gallery/tagging/settings', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const installed = new Map(installedModels(dataDir, catalogue).map((i) => [i.id, i]));
    const pick = (part: TagPart): string | null | undefined => {
      const v = b[part];
      if (v === null) return null;
      if (typeof v !== 'string') return undefined;
      const m = findModel(v, catalogue);
      return m && m.part === part && installed.has(v) ? v : undefined;
    };
    const describe = pick('describe');
    const keywords = pick('keywords');
    if (describe === undefined || keywords === undefined || typeof b.paused !== 'boolean') {
      return void res.status(400).json({ error: 'Choose a downloaded model of the right kind, or Off.' });
    }
    const s: TaggingSettings = { describe, keywords, paused: b.paused };
    saveSettings(s);
    res.json(s);
  });

  return { stop: () => downloading?.abort.abort() };
}
