/** Seconds left in an import, from the pace so far. Null until there is enough to go on. */
export function estimateRemaining(processed: number, total: number, startedAtMs: number, nowMs: number): number | null {
  const elapsed = (nowMs - startedAtMs) / 1000;
  if (processed < 5 || elapsed < 2 || total <= 0) return null;
  return Math.max(0, (elapsed / processed) * (total - processed));
}

export function formatRemaining(seconds: number): string {
  if (seconds < 60) return 'less than a minute left';
  const minutes = Math.ceil(seconds / 60);
  if (minutes >= 90) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `about ${h} ${h === 1 ? 'hour' : 'hours'} ${m} ${m === 1 ? 'minute' : 'minutes'} left`;
  }
  return `about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} left`;
}
