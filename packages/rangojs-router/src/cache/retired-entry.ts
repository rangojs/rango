/**
 * Retiring a stored entry whose stale refresh answered notFound().
 *
 * A stale-while-revalidate refresh that renders notFound() learned that the
 * record behind the entry is gone. Writing nothing would keep the old page
 * serving, with status 200, until the SWR window ends or a tag invalidates it.
 * So the refresh retires the entry and the next request runs the handler,
 * whose live answer is the 404.
 *
 * Only notFound() retires. A redirect can depend on the request (a session or
 * an auth check), so it does not show the record is gone, and an error or a
 * 5xx is a transient failure: both store nothing and keep the entry, which
 * revalidates on its own schedule.
 *
 * The segment family retires with `store.delete()`. The response and item
 * families have no delete on SegmentCacheStore, so they write a tombstone
 * every store already holds, and their read paths take it for a miss: a
 * bodiless 404 Response (a stored response is served only at status 200) and
 * the RETIRED_ITEM value. A tombstone only ever turns a hit into a miss, so it
 * needs no invalidation gate, and a write that lands after a newer page costs
 * one render.
 */

import type { SegmentCacheStore } from "./types.js";

/**
 * Whether a refresh's response status retires the entry it refreshes: 404,
 * what notFound() answers. Shared by the document cache, the response-route
 * cache and route cache() records.
 */
export function refreshRetiresEntry(status: number): boolean {
  return status === 404;
}

/**
 * The response-family tombstone, written under the entry's key for its
 * window. The readers serve a stored response only at status 200
 * (document-cache.ts, rsc/response-cache-serve.ts), and the built-in stores
 * keep the status.
 */
export async function retireStoredResponse(
  store: SegmentCacheStore,
  key: string,
  ttl: number,
  swr: number | undefined,
  tags?: string[],
): Promise<void> {
  await store.putResponse?.(
    key,
    new Response(null, { status: 404 }),
    ttl,
    swr,
    tags,
  );
}

/**
 * The item-family tombstone value. A stored value is a Flight payload, whose
 * rows start with a hex id, so no value a cached function or loader stores
 * starts with a NUL.
 */
export const RETIRED_ITEM = "\u0000rango:retired";

/** Whether a stored item is the tombstone a notFound() refresh wrote. */
export function isRetiredItem(value: string): boolean {
  return value === RETIRED_ITEM;
}
