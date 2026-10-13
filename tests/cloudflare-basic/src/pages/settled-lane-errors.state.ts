// The flaky loader's switch and run counter, keyed by the page's `run`
// search param (e2e/settled-lane-errors.test.ts). Server only: the actions and
// the loader import it, never a client module.
const broken = new Set<string>();
const runs = new Map<string, number>();

export function breakSettledLaneStock(run: string): void {
  broken.add(run);
}

export function isSettledLaneBroken(run: string): boolean {
  return broken.has(run);
}

export function nextSettledLaneRun(run: string): number {
  const n = (runs.get(run) ?? 0) + 1;
  runs.set(run, n);
  return n;
}
