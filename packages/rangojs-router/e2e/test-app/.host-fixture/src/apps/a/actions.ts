"use server";

import { invalidateClientCache } from "@rangojs/router";

let count = 0;

/**
 * No directive: the client marks its prefetches stale (#1329). Writes the
 * counter that the page at `/?delegated-prefetch=1` shows, and returns it.
 */
export async function plainThroughAction(): Promise<number> {
  count += 1;
  return count;
}

/** What the page at `/?delegated-prefetch=1` shows. */
export async function readCount(): Promise<number> {
  return count;
}

/** The server seat of invalidateClientCache(): the client flushes and rotates. */
export async function invalidateThroughAction(): Promise<void> {
  invalidateClientCache();
}
