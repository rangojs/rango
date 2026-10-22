import { cookies } from "@rangojs/router";

// The stale-defaults fixture (e2e stale-defaults.test.ts). The cart and the
// layout's render count are per test, keyed by the sd-key cookie. The cache()
// and ppr pages read no cookie (cache() refuses it, and it would make the
// ppr capture dynamic): their count and renders are keyed by their ?k.
const carts = new Map<string, number>();
const layoutRenders = new Map<string, number>();
const keyedWrites = new Map<string, number>();
const keyedRenders = new Map<string, number>();

function key(): string {
  return cookies().get("sd-key")?.value ?? "";
}

function bump(counts: Map<string, number>, at: string): number {
  const count = (counts.get(at) ?? 0) + 1;
  counts.set(at, count);
  return count;
}

export function readStaleDefaultsCart(): number {
  return carts.get(key()) ?? 0;
}

export function bumpStaleDefaultsCart(): number {
  return bump(carts, key());
}

/** Counts a render of the fixture's layout and returns the count. */
export function countStaleDefaultsLayoutRender(): number {
  return bump(layoutRenders, key());
}

export function readStaleDefaultsKeyed(k: string): number {
  return keyedWrites.get(k) ?? 0;
}

export function bumpStaleDefaultsKeyed(k: string): number {
  return bump(keyedWrites, k);
}

/** Counts a render of the page keyed by `k` and returns the count. */
export function countStaleDefaultsKeyedRender(k: string): number {
  return bump(keyedRenders, k);
}
