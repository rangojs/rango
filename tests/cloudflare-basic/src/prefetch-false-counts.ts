/**
 * Test-only run counters for the /prefetch-false fixture
 * (pages/prefetch-false.tsx), read back by /prefetch-false/__counts so a suite
 * proves on the server that flagged work did not run for a prefetch and ran
 * once for the click. Keyed by the `?run=` every request of one test carries,
 * so parallel tests and retries never share a counter. Bounded: the oldest
 * runs drop.
 */
const MAX_RUNS = 500;
const runs = new Map<string, Map<string, number>>();

export function countRun(run: string, name: string): number {
  let counts = runs.get(run);
  if (!counts) {
    counts = new Map();
    runs.set(run, counts);
    if (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value!);
  }
  const next = (counts.get(name) ?? 0) + 1;
  counts.set(name, next);
  return next;
}

export function readRunCounts(run: string): Record<string, number> {
  return Object.fromEntries(runs.get(run) ?? []);
}
