/**
 * Saves per test key for the rewritten item page (pages/rewrite.tsx,
 * e2e/rewrite.test.ts): the action bumps the count of the `rw-key` cookie, the
 * page shows it, so a test sees whether its mutation ran exactly once.
 */
const saves = new Map<string, number>();

export function getRwItemSaves(key: string): number {
  return saves.get(key) ?? 0;
}

export function bumpRwItemSaves(key: string): void {
  saves.set(key, getRwItemSaves(key) + 1);
}

const loads = new Map<string, number>();
const renders = new Map<string, number>();

/**
 * Runs of the item page's loader and renders of its route per test key: a
 * navigation from the rewritten page that holds them shows the same count.
 */
export function bumpRwItemLoads(key: string): number {
  const n = (loads.get(key) ?? 0) + 1;
  loads.set(key, n);
  return n;
}

export function bumpRwItemRenders(key: string): number {
  const n = (renders.get(key) ?? 0) + 1;
  renders.set(key, n);
  return n;
}
