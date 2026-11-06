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
import { isRedirectResponse } from "../response-utils.js";
import {
  attachRedirectState,
  getRedirectState,
  isExternalRedirect,
  markExternalRedirect,
} from "../redirect-origin.js";

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

/** What every stored entry carries: a store reads them all alike. */
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
 * The redirect a refresh's render answered with, stored in place of the page
 * it replaced. A request that finds it answers the redirect, exactly as the
 * live handler would: the URL moved, and the page that used to be there must
 * not keep serving.
 *
 * `status` and `location` are the Response the render threw. `external` is the
 * out-of-band `redirect(url, { external: true })` brand (a WeakSet membership
 * on that Response object, so it cannot be stored as-is: the rebuilt Response
 * is re-branded) and `soft` is the `X-RSC-Redirect: soft` marker `redirect()`
 * sets and a raw `Response.redirect()` does not.
 */
export interface StoredRedirect {
  status: number;
  location: string;
  external?: boolean;
  soft?: boolean;
  /**
   * `redirect(url, { state })`: the resolved location-state record, re-attached
   * to the rebuilt Response so it reaches the target the way a live redirect's
   * does (the one-shot cookie on a document request, the Flight redirect's
   * `locationState` on a client navigation). It is the render's state, shared by
   * every visitor, which is all a requestless render can produce: state that
   * depends on the visitor reads a cookie first, and the personalization guard
   * turns that into `skipped-personalized`. Plain JSON only, as for a document
   * redirect (`server/document-location-state.ts`).
   */
  state?: Record<string, unknown>;
}

/**
 * The stored redirect: a page-like entry (its `meta` is a page's, so it goes
 * stale and carries tags like one) whose answer is a redirect, not a payload.
 */
type StoredRedirectEntry = StoredEnvelope & {
  redirect: StoredRedirect;
  entry?: never;
  removed?: never;
};

/**
 * Versioned envelope the router composes on a refresh or a removal and
 * verifies on every read: a page, the marker that the page was removed, or the
 * redirect the page now answers with. A store persists any of them as given
 * and returns it as stored.
 */
export type PrerenderStoredEntry =
  | StoredPage
  | StoredTombstone
  | StoredRedirectEntry;

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
   * Persist `stored` (a page, the marker that the page was removed, or the
   * redirect it now answers with) under `key`, replacing any previous entry. No
   * expiry.
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
 * @internal Compose the versioned envelope the trigger hands to `store.set()`.
 * `now` is `meta.storedAt`; `staleFrom` (default `now`) is where the ttl
 * starts counting. Both are passed explicitly so tests stay deterministic.
 */
export function composeStoredEntry(
  key: PrerenderKey,
  entry: PrerenderEntry,
  options: StoredEntryOptions,
  now: number,
  staleFrom: number = now,
): StoredPage {
  // Only a finite, non-negative ttl produces a staleAt: NaN would never go
  // stale and a negative ttl would be stale on every request.
  const hasTtl =
    options.ttl != null &&
    Number.isFinite(options.ttl) &&
    (options.ttl as number) >= 0;
  return {
    v: 1,
    entry,
    meta: {
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
    },
  };
}

/**
 * @internal Compose the "removed" marker stored in place of a page. Its meta
 * is a page's (composeStoredEntry), so `ttl` and `tags` mean the same: the
 * marker of a render outcome is given the route's and is rechecked like a
 * page; `prerender.remove()` gives neither, and its marker never goes stale.
 */
export function composeStoredTombstone(
  key: PrerenderKey,
  options: StoredEntryOptions,
  now: number,
  staleFrom: number = now,
): StoredTombstone {
  const { v, meta } = composeStoredEntry(
    key,
    { segments: [], handles: "" },
    options,
    now,
    staleFrom,
  );
  return { v, removed: true, meta };
}

/**
 * @internal Compose the stored redirect for a render that answered with one.
 * Its meta is a page's (composeStoredEntry): a redirect carries the route's ttl
 * and tags and is rechecked like a page, because the target may move back.
 */
export function composeStoredRedirect(
  key: PrerenderKey,
  redirect: StoredRedirect,
  options: StoredEntryOptions,
  now: number,
  staleFrom: number = now,
): StoredRedirectEntry {
  const { v, meta } = composeStoredEntry(
    key,
    { segments: [], handles: "" },
    options,
    now,
    staleFrom,
  );
  return { v, redirect, meta };
}

/**
 * @internal The stored form of a Response a requestless render threw, or null
 * when it is not a redirect (no 3xx, or no Location): a raw 200/file response
 * cannot be replayed from a requestless render, so the trigger keeps treating
 * it as render-failed.
 */
export function toStoredRedirect(response: Response): StoredRedirect | null {
  if (!isRedirectResponse(response)) return null;
  const state = getRedirectState(response);
  // isRedirectResponse guarantees a Location.
  return {
    status: response.status,
    location: response.headers.get("Location")!,
    ...(isExternalRedirect(response) ? { external: true } : {}),
    ...(response.headers.get("X-RSC-Redirect") === "soft"
      ? { soft: true }
      : {}),
    ...(state && Object.keys(state).length > 0 ? { state } : {}),
  };
}

/**
 * @internal Rebuild the Response a stored redirect answers with, in the shape
 * `redirect()` produces. The serve path throws it, so the request re-enters the
 * one short-circuit every handler redirect takes: a partial request converts it
 * to a Flight redirect, the document path returns it, and the outgoing guard
 * reads the same-origin rule (and the re-branded `external` opt-in).
 */
export function toRedirectResponse(redirect: StoredRedirect): Response {
  const response = new Response(null, {
    status: redirect.status,
    headers: {
      Location: redirect.location,
      ...(redirect.soft === true ? { "X-RSC-Redirect": "soft" } : {}),
    },
  });
  if (redirect.external === true) markExternalRedirect(response);
  // The carriers (rsc/helpers.ts interceptRedirectForPartial for a partial
  // request, server/document-location-state.ts for a document one) read the
  // state off the Response when the request has none of its own.
  if (redirect.state) attachRedirectState(response, redirect.state);
  return response;
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
  // A stored redirect: a 3xx and a Location, or it is malformed (a miss).
  // An envelope carrying both variants is ambiguous, so it is a miss too.
  const redirect = (candidate as { redirect?: unknown }).redirect;
  if (candidate.removed === true && redirect != null) return false;
  const isRedirectEntry = redirect != null && typeof redirect === "object";
  if (
    candidate.v !== 1 ||
    (isRedirectEntry
      ? !isValidStoredRedirect(redirect)
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

function isValidStoredRedirect(value: object): boolean {
  const redirect = value as Partial<StoredRedirect>;
  return (
    typeof redirect.status === "number" &&
    redirect.status >= 300 &&
    redirect.status < 400 &&
    typeof redirect.location === "string" &&
    redirect.location !== "" &&
    (redirect.state == null || typeof redirect.state === "object")
  );
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
