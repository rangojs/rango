// ============================================================================
// KV utilities
// ============================================================================
//
// Pure helpers for the CF cache store's KV (L2) tier: key byte-length limits,
// the expirationTtl floor, and the stale-path Cache-Control recompute. None of
// these reference the store instance, so they live here as standalone functions.

import { CACHE_EXPIRES_AT_HEADER } from "./cf-cache-constants.js";

/** KV key byte-length ceiling. Cloudflare KV rejects keys larger than this. */
export const KV_MAX_KEY_BYTES = 512;

/**
 * Cloudflare KV's minimum `expirationTtl` (seconds). A `put` with a smaller
 * expirationTtl is rejected outright. Tag-invalidation markers (the only writes
 * that take a consumer-supplied TTL via tagInvalidationTtl) are floored to this
 * so a too-small value cannot make EVERY updateTag/revalidateTag throw.
 */
export const KV_MIN_EXPIRATION_TTL = 60;

const kvKeyEncoder = new TextEncoder();

/** UTF-8 byte length of a KV key (multibyte tags can exceed the char count). */
export function kvKeyByteLength(key: string): number {
  return kvKeyEncoder.encode(key).length;
}

/**
 * Compute the Cache-Control directive for a stale-path REVALIDATING re-put from
 * the entry's stored hard-expiry deadline (CACHE_EXPIRES_AT_HEADER). Returns the
 * REMAINING ttl so the re-put preserves the original retention deadline instead
 * of restarting it -- copying set()'s original full-window max-age would reset
 * CF's retention clock on every re-arm and pin a perpetually-stale entry forever.
 * An entry lacking a valid deadline (legacy/tampered) floors to max-age=1, so it
 * hard-expires in ~1s and self-heals via KV. Mirrors promoteSegmentToL1's math.
 * @internal
 */
export function remainingCacheControl(headers: Headers, now: number): string {
  const expiresAt = Number(headers.get(CACHE_EXPIRES_AT_HEADER));
  const remainingTtl =
    Number.isFinite(expiresAt) && expiresAt > 0
      ? Math.max(1, Math.floor((expiresAt - now) / 1000))
      : 1;
  return `public, max-age=${remainingTtl}`;
}
