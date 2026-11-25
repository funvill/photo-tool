import { useEffect, useState } from 'react';
import {
  STYLE_PRESETS, TEMPLATE_EXTRA_PAGES, binding, bookTemplate, defaultGenerationSettings, finishTemplateBook, evenPageCount, generateDraft, printer, starredPool, stylePreset, typePack,
  updateDraft, type GenerationSettings, type PhotoAsset, type UpdateReport,
} from '../../core';
import { useEditor } from '../store';
import { Icon } from '../../../shared/web/components/Icon';
import { BookTemplatesSection } from './BookTemplates';
import { pageLimitWarning, pagesForStarred } from './draftPages';
import { UpdateSummary } from './UpdateSummary';

/**
 * Run the generator as one undoable step and remember its report for the panel. A book started
 * from a template keeps its template pages (front matter, chapter openers, closing pages and the
 * words typed on them) as long as its style stays the template's.
 */
function runDraft(settings: GenerationSettings, allAssets: PhotoAsset[], label: string) {
  const st = useEditor.getState();
  // The draft is built from the starred photos (or every photo when none is starred), and grows
  // to as many pages as that takes.
  const { photos: assets, fellBack } = starredPool(allAssets);
  const maxPerPage = Math.min(7, stylePreset(settings.stylePresetId).maxPerPage);
  const requested = evenPageCount(Math.max(4, settings.targetPages));
  useEditor.setState({ updateReport: null });
  st.run(label, (d) => {
    const t = d.template ? bookTemplate(d.template) : undefined;
    if (t && settings.stylePresetId === t.stylePresetId) {
      // The template adds its own pages, so the photos' page count is the rest.
      const wanted = Math.max(4, requested - TEMPLATE_EXTRA_PAGES);
      const photoPages = pagesForStarred(assets.length, wanted, maxPerPage);
      useEditor.setState({ draftNotes: { fellBack, addedPages: photoPages - wanted } });
      const res = generateDraft(d, assets, { ...settings, targetPages: photoPages, chapterOpeners: true });
      const doc = finishTemplateBook(res.doc, t, assets, d);
      useEditor.setState({ draftReport: { ...res.report, pages: doc.spreads.length * 2 - 2 } });
      return doc;
    }
    const pages = pagesForStarred(assets.length, requested, maxPerPage);
    useEditor.setState({ draftNotes: { fellBack, addedPages: pages - requested } });
    const res = generateDraft(d, assets, { ...settings, targetPages: pages });
    useEditor.setState({ draftReport: res.report });
    return { ...res.doc, template: undefined };
  });
}

/** Empty book: draft it straight away with sensible defaults, so there is something to look at. */
export function generateFirstDraft(assets: PhotoAsset[]) {
  const st = useEditor.getState();
  if (!st.doc) return;
  runDraft(defaultGenerationSettings(st.doc, assets.length), assets, 'Generate draft');
  st.goToSpread(1);
}

/** Bring the draft in line with the stars as one undo step, keeping pages changed by hand. */
function runUpdate(assets: PhotoAsset[], saved: GenerationSettings) {
  const st = useEditor.getState();
  let report: UpdateReport | null = null;
  const ok = st.run('Update draft', (d) => {
    const res = updateDraft(d, assets, d.generation?.settings ?? saved);
    report = res.report;
    return res.doc;
  });
  // An update never falls back to every photo; its own notes (shown in the summary) say when nothing is starred.
  if (ok && report) useEditor.setState({ updateReport: report, draftReport: null, draftNotes: { fellBack: false, addedPages: 0 } });
}

/**
 * Auto draft in the side panel: the pages stay visible while you regenerate, and you can flip
 * through spreads between variations. Regenerating keeps you on the spread you are looking at.
 */
export function DraftPanel() {
  const doc = useEditor((s) => s.doc)!;
  const assets = useEditor((s) => s.assets);
  const report = useEditor((s) => s.draftReport);
  const updateReport = useEditor((s) => s.updateReport);
  const notes = useEditor((s) => s.draftNotes);
  const saved = doc.generation?.settings ?? defaultGenerationSettings(doc, assets.length);
  const [pages, setPages] = useState(saved.targetPages);
  const [presetId, setPresetId] = useState(doc.style.presetId);
  const [captions, setCaptions] = useState(saved.includeCaptions);
  const [openers, setOpeners] = useState(!!saved.chapterOpeners);
  // Follow the book when it changes underneath (undo, another window).
  useEffect(() => setPages(doc.spreads.length * 2 - 2), [doc.spreads.length]);
  useEffect(() => setPresetId(doc.style.presetId), [doc.style.presetId]);

  const locked = doc.spreads.filter((s) => s.locked).length;
  const bind = binding(doc.settings);
  const pr = printer(doc.settings.printerId);
  const target = evenPageCount(Math.max(4, pages));
  // After a Generate or Update, the book's actual page count counts too: it can grow past the target.
  const pageWarning = pageLimitWarning(pr.name, bind, target, report || updateReport ? doc.spreads.length * 2 - 2 : undefined);
  const usable = assets.filter((a) => !a.excluded && !a.missing).length;
  const hasContent = doc.spreads.some((s) => !s.locked && s.elements.length);
  const drafted = doc.spreads.some((s) => s.provenance);
  const settingsChanged = target !== doc.spreads.length * 2 - 2 || presetId !== (doc.generation?.settings.stylePresetId ?? doc.style.presetId) || captions !== saved.includeCaptions || openers !== !!saved.chapterOpeners;

  const generate = (seed: number) => {
    const at = useEditor.getState().currentSpread;
    runDraft({ targetPages: target, stylePresetId: presetId, ordering: 'chronological', includeCaptions: captions, chapterOpeners: openers, seed }, assets, hasContent ? 'Regenerate draft' : 'Generate draft');
    // Stay on the same spread (clamped) so you can compare variations in place.
    useEditor.getState().goToSpread(hasContent ? at : 1);
  };

  return (
    <div className="stack">
      <div className="section-title">Book templates</div>
      <BookTemplatesSection />
      <div className="auto-collage">
        <div className="row between">
          <strong>Auto draft</strong>
          {hasContent && <span className="muted small">{doc.spreads.length * 2 - 2} pages</span>}
        </div>
        {usable === 0 ? (
          <p className="muted small">Import photos in the library first.</p>
        ) : (
          <>
            <div className="field-row">
              <label className="field">
                <span>Pages</span>
                <div className="stepper">
                  <button onClick={() => setPages(Math.max(4, target - 2))} aria-label="Fewer pages">−</button>
                  <input type="number" value={pages} min={4} max={800} step={2} onChange={(e) => setPages(Number(e.target.value))} onBlur={() => setPages(target)} />
                  <button onClick={() => setPages(Math.min(800, target + 2))} aria-label="More pages">+</button>
                </div>
              </label>
              <label className="field check">
                <input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} />
                <span>Date captions</span>
              </label>
              <label className="field check" title="Start every chapter (day) on its own opener page">
                <input type="checkbox" checked={openers} onChange={(e) => setOpeners(e.target.checked)} />
                <span>Chapter pages</span>
              </label>
            </div>
            <div className="btn-grid">
              {drafted ? (
                <>
                  <button className="btn btn-small btn-primary" onClick={() => runUpdate(assets, saved)} title="Add and remove photos to match your stars">
                    <Icon name="sparkle" /> Update from stars
                  </button>
                  <button className="btn btn-small" onClick={() => generate(settingsChanged ? 1 : saved.seed)} title="Draft the unlocked pages again with these settings">
                    <Icon name="shuffle" /> Rebuild all pages
                  </button>
                  <button className="btn btn-small" onClick={() => generate(saved.seed + 1)} title="Same settings, a different arrangement">
                    <Icon name="shuffle" /> Another variation
                  </button>
                </>
              ) : (
                <>
                  <button className="btn btn-small btn-primary" onClick={() => generate(1)} title="Draft the pages from your starred photos">
                    <Icon name="sparkle" /> Generate
                  </button>
                  <button className="btn btn-small" disabled={!hasContent} onClick={() => generate(saved.seed + 1)} title="Same settings, a different arrangement">
                    <Icon name="shuffle" /> Another variation
                  </button>
                </>
              )}
            </div>
            {pageWarning && <div className="notice notice-error small"><Icon name="alert" /> {pageWarning}</div>}
            {locked > 0 && <p className="muted small"><Icon name="lock" size={11} /> {locked} locked spread{locked > 1 ? 's' : ''} kept as {locked > 1 ? 'they are' : 'it is'}{doc.cover?.locked ? ', and the locked cover' : ''}.</p>}
            {updateReport && <UpdateSummary report={updateReport} />}
            {notes.fellBack && (report || updateReport) && <p className="muted small">No photos are starred, so every photo was used.</p>}
            {notes.addedPages > 0 && report && <p className="muted small">Added {notes.addedPages} pages so every starred photo fits.</p>}
            {report && (
              <p className="muted small">
                {report.pages} pages · {report.selected} photos placed{report.heroSpreads ? ` · ${report.heroSpreads} panorama${report.heroSpreads > 1 ? 's' : ''}` : ''} · {report.nearDuplicatesSet} similar shots set aside
                {report.exactDuplicates ? ` · ${report.exactDuplicates} duplicates skipped` : ''}{report.notes.length ? ` · ${report.notes.join(' ')}` : ''}
              </p>
            )}
            <p className="muted small">Uses your starred photos, in time order. Update adds and removes photos to match your stars and leaves pages you changed by hand alone. Undo brings back the previous version.</p>
          </>
        )}
      </div>

      <div className="section-title">Style {settingsChanged && hasContent ? <span className="pending-tag">applies on Regenerate</span> : null}</div>
      <div className="style-cards compact">
        {STYLE_PRESETS.map((p) => (
          <button key={p.id} className={`style-card ${presetId === p.id ? 'on' : ''}`} onClick={() => setPresetId(p.id)} title={p.description}>
            <div className="style-swatch" style={{ background: p.style.background, color: p.style.textColor, fontFamily: `'${typePack(p.typePack).roles.title.family}'` }}>
              <span>Aa</span>
            </div>
            <strong>{p.name}</strong>
          </button>
        ))}
      </div>
      <p className="muted small">{STYLE_PRESETS.find((p) => p.id === presetId)?.description}</p>
    </div>
  );
}
