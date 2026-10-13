/**
 * Saves per test key for the rewritten item page (urls/rewrite.tsx,
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
