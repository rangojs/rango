// Per-run call counters for the prefetch-render-errors fixture, keyed by the
// route and the page's `run` (prefetch-render-errors.test.ts). Server only.
const runs = new Map<string, number>();

export function nextPrefetchRenderRun(key: string): number {
  const n = (runs.get(key) ?? 0) + 1;
  runs.set(key, n);
  return n;
}
