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
 * Structured durable-overlay key. Includes the router's cache version so a
 * deploy that changed the router's server code never reads Flight payloads
 * that reference its previous build, and so Cloudflare gradual deployments
 * stay correct (old and new worker versions each read their own namespace).
 */
export interface PrerenderKey {
  routerId: string;
  /**
   * The owning router's cache version (its data version). Opaque: never set
   * or read by app code; a store keys off it as given.
   */
  version: string;
  routeName: string;
  /** DJB2 8-hex hash of the canonical params (see param-hash.ts). */
  paramHash: string;
}

/**
 * @internal What the trigger stamps on a write. TTL is soft staleness metadata
 * (`staleAt`), never a hard store expiry: hard expiry would delete the entry
 * a stale-while-revalidate serve needs, and an expired overlay would fall back
 * to older bundled-manifest content.
 */
export interface StoredEntryOptions {
  /** Seconds until the entry is considered stale. Absent = never stale. */
  ttl?: number;
  tags: string[];
  /** Canonical params, stored for verify-on-read. */
  params: Record<string, string>;
}

/** What a page and a "removed" marker both carry: a store reads either alike. */
interface StoredEnvelope {
  v: 1;
  meta: {
    /**
     * When the render started, not when the entry was written: a `markStale()`
     * at or after it (strictly after in an in-process store) covers the entry.
     * A `remove()` marker renders nothing and carries its write time.
     */
    storedAt: number;
    /**
     * Absent = never stale. Soft metadata only; controls `onRevalidate`
     * scheduling, not serving. Counts the ttl from the write. A store may
     * lower it (tag markers do).
     */
    staleAt?: number;
    /** The configured ttl in seconds, as a result reports it. Absent = none. */
    ttl?: number;
    tags: string[];
    /** The key's `version` at write time; verified on read. */
    version: string;
    /** Verified against the request's params on read (DJB2 collision guard). */
    params: Record<string, string>;
  };
}

type StoredPage = StoredEnvelope & {
  entry: PrerenderEntry;
  removed?: never;
  redirect?: never;
};

/**
 * What a stored redirect answers with. `location` is the target the render
 * produced, before the serving request's basename: `redirect()` prefixes the
 * basename of the request it runs in, and a requestless render has none, so
 * the stored value is the app path and each request prefixes its own. A store
 * holds no Response: the out-of-band brands `redirect()` sets on one (the
 * `{ external: true }` opt-in, location state) are WeakSet/WeakMap membership
 * and cannot cross a store, so `external` rides the envelope as a field and a
 * redirect carrying location state is not storable at all.
 */
export interface StoredRedirectTarget {
  /** The `Location` the render produced (`redirect()`'s argument). */
  location: string;
  /** The status the render produced: 302 unless the app asked for another. */
  status: number;
  /** The render's `redirect(url, { external: true })` opt-in. */
  external?: true;
}

/**
 * The "removed" marker (tombstone) stored in place of a page, by
 * `prerender.remove()` or by a refresh whose render hit `notFound()` (or
 * declined with `ctx.passthrough()`). A request that finds it is not served
 * the build-time entry below the overlay. No `entry`: a router from before the
 * marker rejects it as malformed (a miss) instead of serving an empty page.
 * `meta` is stamped like a page's for a render outcome, so that marker goes
 * stale and is rechecked; a `remove()` marker has no `staleAt` and no tags.
 */
type StoredTombstone = StoredEnvelope & {
  removed: true;
  entry?: never;
  redirect?: never;
};

/**
 * The redirect stored in place of a page, by a refresh whose render redirected
 * (`redirect()` returned from the route handler or from a layout handler: the
 * results the resolution boundary awaits, which is where a Response
 * short-circuits. A redirect thrown while the tree is encoded — a component's,
 * or a `loading()` handler's — is rendered into the stream instead, in the
 * live path too: see warnOnStreamedResponse in
 * router/segment-resolution/helpers.ts). A request that finds it is answered
 * with that redirect, never with a page or the build-time entry below the
 * overlay: the render said this URL is no longer the page, and the target it
 * named is the answer.
 *
 * No `entry`: a router from before this variant rejects it as malformed (a
 * miss) instead of serving an empty page. `meta` is stamped like a page's, so
 * the redirect goes stale and is rechecked like one.
 */
type StoredRedirect = StoredEnvelope & {
  redirect: StoredRedirectTarget;
  entry?: never;
  removed?: never;
};

/**
 * Versioned envelope the router composes on a refresh or a removal and
 * verifies on every read: a page, the marker that the page was removed, or the
 * redirect that answers in its place. A store persists any of them as given
 * and returns it as stored.
 */
export type PrerenderStoredEntry =
  | StoredPage
  | StoredTombstone
  | StoredRedirect;

/**
 * The writable durable overlay: plain get/set. Backed in production by a
 * platform adapter (Cloudflare KV, …) and in dev/tests by an in-memory store.
 * The router composes the envelope before `set()` and verifies whatever `get()`
 * returns (shape, `version`, params collision guard), so a store holds no
 * policy of its own.
 *
 * Key everything off the `key` argument (`serializePrerenderKey(key)` carries
 * `key.version`). Never call `getCacheVersions()` here: the trigger's `set()`
 * runs outside the producer's request context, where it returns the
 * whole-build fallback instead of the owning router's version.
 */
export interface WritablePrerenderStore {
  /**
   * The envelope stored under `key`, or null. Never memoize a miss: a refresh
   * can write the key after a request missed it. May lower `meta.staleAt` (a
   * tag marked stale after the entry was written).
   */
  get(key: PrerenderKey): Promise<PrerenderStoredEntry | null>;

  /**
   * Persist `stored` (a page, or the marker that the page was removed) under
   * `key`, replacing any previous entry. No expiry.
   */
  set(key: PrerenderKey, stored: PrerenderStoredEntry): Promise<void>;

  delete?(key: PrerenderKey): Promise<void>;

  /**
   * Mark the entries of router `routerId` (`PrerenderKey.routerId`) carrying
   * any of `tags` stale (they keep serving). A mark covers an entry whose
   * `meta.storedAt` it is at or after (strictly after for an in-process
   * store), including one `set()` after the mark: a store that marks held
   * entries in place has to remember its marks. Scope it to that router: routers
   * behind a host router share one store, and a tag is only meaningful inside
   * the router whose routes declared it. Optional: without it,
   * `router.prerender().markStale()` is a no-op for this store.
   */
  markStale?(routerId: string, tags: string[]): Promise<void>;
}

/**
 * Serialize a {@link PrerenderKey} to the design's string form:
 *   `prerender:{routerId}:{version}:{routeName}:{paramHash}`
 */
export function serializePrerenderKey(key: PrerenderKey): string {
  return `prerender:${key.routerId}:${key.version}:${key.routeName}:${key.paramHash}`;
}

/**
 * @internal The `meta` all three envelopes carry, composed once so a page, a
 * marker and a redirect cannot drift in how `ttl` or `tags` are stamped.
 * `now` is `meta.storedAt`; `staleFrom` (default `now`) is where the ttl
 * starts counting. Both are passed explicitly so tests stay deterministic.
 */
function composeStoredMeta(
  key: PrerenderKey,
  options: StoredEntryOptions,
  now: number,
  staleFrom: number,
): StoredEnvelope["meta"] {
  // Only a finite, non-negative ttl produces a staleAt: NaN would never go
  // stale and a negative ttl would be stale on every request.
  const hasTtl =
    options.ttl != null &&
    Number.isFinite(options.ttl) &&
    (options.ttl as number) >= 0;
  return {
    storedAt: now,
    ...(hasTtl
      ? {
          staleAt: staleFrom + (options.ttl as number) * 1000,
          ttl: options.ttl as number,
        }
      : {}),
    tags: options.tags,
    version: key.version,
    params: options.params,
  };
}

/**
 * @internal Compose the versioned envelope the trigger hands to `store.set()`.
 */
export function composeStoredEntry(
  key: PrerenderKey,
  entry: PrerenderEntry,
  options: StoredEntryOptions,
  now: number,
  staleFrom: number = now,
): StoredPage {
  return { v: 1, entry, meta: composeStoredMeta(key, options, now, staleFrom) };
}

/**
 * @internal Compose the "removed" marker stored in place of a page. Its meta
 * is a page's, so `ttl` and `tags` mean the same: the marker of a render
 * outcome is given the route's and is rechecked like a page;
 * `prerender.remove()` gives neither, and its marker never goes stale.
 */
export function composeStoredTombstone(
  key: PrerenderKey,
  options: StoredEntryOptions,
  now: number,
  staleFrom: number = now,
): StoredTombstone {
  return {
    v: 1,
    removed: true,
    meta: composeStoredMeta(key, options, now, staleFrom),
  };
}

/**
 * @internal Compose the redirect stored in place of a page by a refresh whose
 * render redirected. Its meta is a page's, so `ttl` and `tags` mean the same
 * and the redirect is rechecked like a page.
 */
export function composeStoredRedirect(
  key: PrerenderKey,
  redirect: StoredRedirectTarget,
  options: StoredEntryOptions,
  now: number,
  staleFrom: number = now,
): StoredRedirect {
  return {
    v: 1,
    redirect,
    meta: composeStoredMeta(key, options, now, staleFrom),
  };
}

/**
 * @internal Verify a store's answer is safe to serve for this key: the
 * envelope shape and version tag, the key version, and the stored params
 * against the request's (the 8-hex DJB2 collision guard, param-hash.ts: a
 * runtime write keyed off webhook-supplied params must not serve one page's
 * content under another's URL, nor remove another's page). False means treat
 * it as a miss. Run by the router on every read, so a third-party store
 * cannot skip it.
 */
export function isStoredEntryValidFor(
  stored: unknown,
  key: PrerenderKey,
  params: Record<string, string>,
): stored is PrerenderStoredEntry {
  // A durable store can hold a parseable-but-malformed value (`"null"`,
  // `{"v":1}`): a miss, never a TypeError on the serve path.
  if (stored == null || typeof stored !== "object") return false;
  const candidate = stored as Partial<PrerenderStoredEntry>;
  const entry = candidate.entry;
  const meta = candidate.meta;
  // Three shapes, told apart by what they carry: a page (`entry`), the
  // "removed" marker (`removed: true`), the redirect that answers in its place
  // (`redirect`). A mixed envelope is malformed, not a page with extra fields.
  const redirect = candidate.redirect;
  const hasRedirect = redirect != null;
  if (
    candidate.v !== 1 ||
    (hasRedirect
      ? candidate.removed === true ||
        entry != null ||
        typeof redirect !== "object" ||
        typeof redirect.location !== "string" ||
        redirect.location === "" ||
        typeof redirect.status !== "number"
      : // The "removed" marker has no entry; a page must have a whole one.
        candidate.removed !== true &&
        (entry == null ||
          typeof entry !== "object" ||
          !Array.isArray(entry.segments) ||
          typeof entry.handles !== "string")) ||
    meta == null ||
    typeof meta !== "object" ||
    !Array.isArray(meta.tags) ||
    typeof meta.storedAt !== "number"
  ) {
    return false;
  }
  if (meta.version !== key.version) return false;
  return paramsEqual(meta.params ?? {}, params);
}

/** True once `now` has passed the entry's soft `staleAt`. Never-stale entries never go stale. */
export function isStoredEntryStale(
  stored: PrerenderStoredEntry,
  now: number,
): boolean {
  return stored.meta.staleAt != null && now >= stored.meta.staleAt;
}

/**
 * @internal Lower `meta.staleAt` to `at` when it is unset or later. Shared by
 * the stores' tag marking so the rule cannot drift between them.
 */
export function lowerStoredEntryStaleAt(
  stored: PrerenderStoredEntry,
  at: number,
): void {
  if (stored.meta.staleAt == null || stored.meta.staleAt > at) {
    stored.meta.staleAt = at;
  }
}

/**
 * @internal `store.get(key)` verified for serving (isStoredEntryValidFor). A
 * store error (e.g. a KV outage) reads as a miss: the serve path falls back to
 * the bundled manifest or live handler, and the trigger's stale check renders.
 */
export async function readVerifiedStoredEntry(
  store: WritablePrerenderStore,
  key: PrerenderKey,
  params: Record<string, string>,
): Promise<PrerenderStoredEntry | null> {
  try {
    const read = await store.get(key);
    return isStoredEntryValidFor(read, key, params) ? read : null;
  } catch {
    return null;
  }
}
