/**
 * Writable prerender store contract for on-demand (ISR-style) prerender refresh.
 *
 * The bundled build manifest (store.ts) is immutable and read-only. On-demand
 * prerender adds a writable durable overlay in front of it: `router.prerender()`
 * renders a route and writes a versioned envelope here; the serve path reads the
 * overlay before the bundled manifest.
 *
 * This module is types + pure helpers only — no React/RSC/plugin-rsc imports —
 * so it can be imported by the testing barrel and platform adapters alike.
 */

import type { PrerenderEntry } from "./store.js";
import { paramsEqual } from "../router/params-util.js";

/**
 * Structured durable-overlay key. Includes the deployment identity (buildId) so
 * a new deploy never reads Flight payloads that reference previous client
 * references or chunks, and so Cloudflare gradual deployments stay correct (old
 * and new worker versions each read their own build-scoped namespace).
 */
export interface PrerenderKey {
  routerId: string;
  /** Per-deploy identity (the router `version` / VERSION constant). */
  buildId: string;
  routeName: string;
  /** DJB2 8-hex hash of the canonical params (see param-hash.ts). */
  paramHash: string;
  /** Intercept variant (stored under a `:i` suffix), matching the manifest convention. */
  intercept?: boolean;
}

/**
 * Read-time contract every writable store honors (unlike the legacy
 * `PrerenderStore.get` `meta`, which only the dev store read). `params` is the
 * canonical matched-param map, verified against the stored envelope's
 * `meta.params` — the cheap guard against the documented 8-hex DJB2 collision
 * (param-hash.ts): a runtime write keyed off webhook-supplied params must not
 * silently serve one page's content under another's URL.
 */
export interface PrerenderLookupMeta {
  params: Record<string, string>;
}

/**
 * Options for a durable write. TTL is soft staleness metadata (`staleAt`), never
 * a hard store expiry: hard expiry would delete the entry SWR needs to serve
 * stale, and an expired overlay would fall back to older bundled-manifest
 * content.
 */
export interface PrerenderSetOptions {
  /** Seconds until the entry is considered stale. Absent = never stale. */
  ttl?: number;
  tags?: string[];
  /** Canonical params, stored for verify-on-read. */
  params: Record<string, string>;
}

/**
 * Versioned envelope the store composes from a raw {@link PrerenderEntry} on
 * `set()` and returns on `get()`.
 */
export interface PrerenderStoredEntry {
  v: 1;
  entry: PrerenderEntry;
  meta: {
    storedAt: number;
    /** Absent = never stale. Soft metadata only; controls SWR scheduling, not serving. */
    staleAt?: number;
    tags: string[];
    buildId: string;
    /** Verified against the request's params on read (DJB2 collision guard). */
    params: Record<string, string>;
  };
}

/**
 * The writable durable overlay. Backed in production by a platform adapter
 * (Cloudflare KV, Vercel Blob, …) and in dev/tests by an in-memory store.
 */
export interface WritablePrerenderStore {
  get(
    key: PrerenderKey,
    meta: PrerenderLookupMeta,
  ): Promise<PrerenderStoredEntry | null>;

  set(
    key: PrerenderKey,
    entry: PrerenderEntry,
    options: PrerenderSetOptions,
  ): Promise<void>;

  delete?(key: PrerenderKey): Promise<void>;

  invalidateTags?(tags: string[]): Promise<void>;
}

/**
 * Serialize a {@link PrerenderKey} to the design's string form:
 *   `prerender:{routerId}:{buildId}:{routeName}:{paramHash}[:i]`
 */
export function serializePrerenderKey(key: PrerenderKey): string {
  const base = `prerender:${key.routerId}:${key.buildId}:${key.routeName}:${key.paramHash}`;
  return key.intercept ? `${base}:i` : base;
}

/**
 * Compose a versioned envelope from a raw entry + write options. `now` is passed
 * explicitly so stores stay deterministic/testable.
 */
export function composeStoredEntry(
  key: PrerenderKey,
  entry: PrerenderEntry,
  options: PrerenderSetOptions,
  now: number,
): PrerenderStoredEntry {
  // Only a finite, non-negative ttl produces a staleAt. A NaN ttl would yield a
  // NaN staleAt (silently never stale); a negative ttl a past staleAt (stale on
  // every request). Either is a misconfiguration — treat it as never-stale.
  const hasTtl =
    options.ttl != null &&
    Number.isFinite(options.ttl) &&
    (options.ttl as number) >= 0;
  return {
    v: 1,
    entry,
    meta: {
      storedAt: now,
      ...(hasTtl ? { staleAt: now + (options.ttl as number) * 1000 } : {}),
      tags: options.tags ?? [],
      buildId: key.buildId,
      params: options.params,
    },
  };
}

/**
 * Verify a stored envelope is safe to serve for this lookup: the version tag
 * matches and the stored params equal the request's params (collision guard).
 * Returns false when the entry must be treated as a miss.
 */
export function isStoredEntryValidFor(
  stored: PrerenderStoredEntry,
  key: PrerenderKey,
  meta: PrerenderLookupMeta,
): boolean {
  // Shape-check first: a durable store can hold a parseable-but-malformed value
  // (e.g. the literal `"null"`, or `{"v":1}` with no meta). Read those as a miss
  // rather than dereferencing into a TypeError on the serve path.
  if (
    stored == null ||
    typeof stored !== "object" ||
    stored.v !== 1 ||
    stored.meta == null ||
    typeof stored.meta !== "object"
  ) {
    return false;
  }
  if (stored.meta.buildId !== key.buildId) return false;
  return paramsEqual(stored.meta.params ?? {}, meta.params);
}

/** True once `now` has passed the entry's soft `staleAt`. Never-stale entries never go stale. */
export function isStoredEntryStale(
  stored: PrerenderStoredEntry,
  now: number,
): boolean {
  return stored.meta.staleAt != null && now >= stored.meta.staleAt;
}
