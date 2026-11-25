import { useGallery } from '../store';

/** Short messages in the corner (the editor's look). Click one to dismiss it. */
export function Toasts() {
  const toasts = useGallery((s) => s.toasts);
  return (
    <div className="toasts" role="status">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => useGallery.getState().dismissToast(t.id)}>{t.text}</div>
      ))}
    </div>
  );
}
