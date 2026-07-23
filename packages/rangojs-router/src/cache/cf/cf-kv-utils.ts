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
 * Bytes of a composed key preserved verbatim when an over-limit key is
 * normalized (toKVKey). 400 leaves room for the `~` separator and the 32-hex
 * digest inside KV_MAX_KEY_BYTES while keeping the version prefix and most of
 * the logical key readable (and prefix-listable) in the KV dashboard.
 */
export const KV_KEY_PRESERVED_PREFIX_BYTES = 400;

/**
 * Truncate to at most `maxBytes` of UTF-8. A multibyte sequence split at the
 * boundary decodes to U+FFFD, which is stripped — the result is deterministic
 * for a given input, which is all key normalization needs.
 */
export function truncateToBytes(value: string, maxBytes: number): string {
  const bytes = kvKeyEncoder.encode(value);
  if (bytes.length <= maxBytes) return value;
  return new TextDecoder()
    .decode(bytes.subarray(0, maxBytes))
    .replace(/�+$/, "");
}

/**
 * 128-bit hex digest (SHA-256 truncated) of a composed KV key. WebCrypto is
 * available on workerd and Node alike; SHA-256 (not a fast non-crypto hash)
 * because cache keys embed user-influenced serialized args — an engineered
 * collision between two normalized keys would serve one entry's payload for
 * the other's.
 */
export async function kvKeyDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    kvKeyEncoder.encode(value),
  );
  return Array.from(new Uint8Array(digest, 0, 16), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
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
