/// <reference path="../../vite/plugins/version.d.ts" />

// Extend CacheStorage with Cloudflare's default cache property
declare global {
  interface CacheStorage {
    readonly default: Cache;
  }
}

/**
 * Cloudflare Edge Cache Store
 *
 * Production cache store using Cloudflare's Cache API (L1) with optional
 * KV persistence (L2).
 *
 * L1 (Cache API): Per-colo, fast, ephemeral. Handles SWR atomically.
 * L2 (KV): Global, persistent, ~50ms reads. Auto-warms cold colos.
 *
 * Read flow:  L1 hit → serve | L1 miss → L2 hit → serve + promote to L1 | both miss → render
 * Write flow: L1 write + L2 write (both via waitUntil)
 *
 * Features:
 * - Extended TTL for SWR window (max-age = ttl + swr)
 * - Staleness via x-edge-cache-stale-at header
 * - Atomic REVALIDATING status for thundering herd prevention (L1 only)
 * - Non-blocking writes via waitUntil
 * - KV L2 for cross-colo cache persistence
 */

import type {
  SegmentCacheStore,
  CachedEntryData,
  CacheDefaults,
  CacheGetResult,
  CacheItemResult,
  CacheItemOptions,
} from "../types.js";
import {
  _getRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import { VERSION } from "@rangojs/router:version";
import {
  resolveTtl,
  resolveSwrWindow,
  DEFAULT_FUNCTION_TTL,
} from "../cache-policy.js";
import { reportCacheError, reportingAsync } from "../cache-error.js";
import type { CacheErrorCategory } from "../cache-error.js";

// ============================================================================
// Constants
// ============================================================================

/** Header storing timestamp when entry becomes stale */
export const CACHE_STALE_AT_HEADER = "x-edge-cache-stale-at";

/** Header storing cache status: HIT | REVALIDATING */
export const CACHE_STATUS_HEADER = "x-edge-cache-status";

/**
 * Header storing this entry's cache tags as a JSON array. JSON-encoded (not the
 * comma-delimited CF `Cache-Tag` format) so tags containing commas round-trip
 * safely; the read paths parse this to run the tag-invalidation check.
 */
export const CACHE_TAGS_HEADER = "x-edge-cache-tags";

/** Header storing the ms-epoch timestamp when this entry's tags were attached. */
export const CACHE_TAGGED_AT_HEADER = "x-edge-cache-tagged-at";

/**
 * KV key prefix for tag-invalidation markers. A marker stores the ms-epoch
 * timestamp of the most recent invalidation of a tag; reads treat any entry
 * whose taggedAt is older than its tags' latest marker as invalidated. Markers
 * live in the SAME KV namespace as the cached entries - there is no separate
 * tag-invalidation store.
 */
const TAG_MARKER_PREFIX = "__tag__/";

/**
 * Cache-API path prefix for the optional per-colo L1 cache of tag-invalidation
 * markers (enabled by tagCacheTtl). Distinct from data keys (doc:/fn:/segment)
 * and from the KV marker prefix so the two never collide.
 */
const TAG_MARKER_CACHE_PREFIX = "__tagmarker__/";

/**
 * Sentinel body for an L1-cached marker meaning "this tag has no invalidation
 * marker." Distinct from any real ms-epoch timestamp (always a large positive
 * integer). A Cache API miss (match() === undefined) always means "re-read KV",
 * never "no marker" - absence is only ever represented by this cached sentinel.
 */
const TAG_MARKER_ABSENT = "none";

/**
 * Header stashing the route author's original Cache-Control on L1 document
 * entries. putResponse/promoteResponseToL1 overwrite Cache-Control with a long
 * `max-age` so the CF Cache API retains the entry across the whole SWR window;
 * getResponse restores this original value before serving so the client and any
 * upstream CDN see the author's intended directive, not the internal edge TTL.
 */
const CACHE_ORIG_CC_HEADER = "x-edge-cache-orig-cc";

/**
 * Maximum age in seconds for REVALIDATING status before allowing new revalidation.
 * After this period, a stale entry in REVALIDATING status will trigger revalidation again.
 * @internal
 */
export const MAX_REVALIDATION_INTERVAL = 30;

/**
 * Per-request memo of tag-invalidation markers (tag -> latest invalidatedAt, or
 * null when no marker exists). Keyed by the request context object so it is
 * naturally request-scoped and garbage-collected with the request.
 *
 * Without it, isGloballyInvalidated() issues a KV read per tag on every tagged
 * cache read, so a page composed of many segments/items sharing a tag pays that
 * cost N times. The memo collapses it to one KV read per distinct tag per
 * request. invalidateTags() writes through so a same-request updateTag() stays
 * read-your-own-writes consistent (the action's own re-render sees its own
 * invalidation from the memo, without a re-read).
 *
 * It does NOT span requests, so a hot single-entry route still pays one KV read
 * per request; that read hits Cloudflare KV's own edge read cache for hot keys.
 */
const tagMarkerMemo = new WeakMap<object, Map<string, number | null>>();

function getTagMarkerMemo(ctx: object): Map<string, number | null> {
  let memo = tagMarkerMemo.get(ctx);
  if (!memo) {
    memo = new Map();
    tagMarkerMemo.set(ctx, memo);
  }
  return memo;
}

/**
 * Per-request map of IN-FLIGHT marker reads (tag -> the pending read promise).
 * The resolved-value memo above only collapses SEQUENTIAL reads of a tag; the
 * router resolves sibling segments in PARALLEL, so without this several
 * concurrently-resolving segments sharing a tag would each issue their own KV
 * read before any of them populates the memo. Sharing the in-flight promise
 * collapses those to a single KV read. Entries are dropped once resolved (the
 * value is then in the memo), so this only spans the concurrent read window.
 */
const tagMarkerInflight = new WeakMap<
  object,
  Map<string, Promise<number | null>>
>();

function getTagMarkerInflight(
  ctx: object,
): Map<string, Promise<number | null>> {
  let inflight = tagMarkerInflight.get(ctx);
  if (!inflight) {
    inflight = new Map();
    tagMarkerInflight.set(ctx, inflight);
  }
  return inflight;
}

/** KV key byte-length ceiling. Cloudflare KV rejects keys larger than this. */
const KV_MAX_KEY_BYTES = 512;

const kvKeyEncoder = new TextEncoder();

/** UTF-8 byte length of a KV key (multibyte tags can exceed the char count). */
function kvKeyByteLength(key: string): number {
  return kvKeyEncoder.encode(key).length;
}

/**
 * Stores (by namespace) already warned about tag machinery configured without a
 * KV namespace, so the warning fires once per process rather than per request
 * (CFCacheStore is constructed per request).
 */
const warnedNoKvReadInvalidation = new Set<string>();

// ============================================================================
// Types
// ============================================================================

// Re-exported from the canonical home so cf-cache-store consumers keep
// importing `ExecutionContext` from this module without a second interface
// drifting over time.
export type { ExecutionContext } from "../../types/request-scope.js";
import type { ExecutionContext } from "../../types/request-scope.js";

/**
 * Minimal Cloudflare KV Namespace interface.
 * Avoids hard dependency on @cloudflare/workers-types.
 */
export interface KVNamespace {
  get(key: string, options?: { type?: string }): Promise<any>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * KV envelope for segment cache entries.
 * @internal
 */
interface KVSegmentEnvelope {
  /** Cached segment data */
  d: CachedEntryData;
  /** When entry becomes stale (ms epoch) */
  s: number;
  /** When entry hard-expires (ms epoch) */
  e: number;
}

/**
 * KV envelope for function cache entries ("use cache").
 * @internal
 */
interface KVItemEnvelope {
  /** RSC-serialized return value */
  v: string;
  /** Handle data */
  h?: Record<string, Record<string, unknown[]>>;
  /** When entry becomes stale (ms epoch) */
  s: number;
  /** When entry hard-expires (ms epoch) */
  e: number;
  /** Cache tags (for distributed tag invalidation) */
  t?: string[];
  /** Timestamp when tags were attached (ms epoch) */
  ta?: number;
}

/**
 * KV envelope for document cache entries.
 * @internal
 */
interface KVResponseEnvelope {
  /** Response body as base64-encoded string (safe for binary payloads) */
  b: string;
  /** HTTP status code */
  st: number;
  /** HTTP status text */
  stx: string;
  /** Serialized headers as key-value pairs (client-facing; no internal headers) */
  hd: [string, string][];
  /** When entry becomes stale (ms epoch) */
  s: number;
  /** When entry hard-expires (ms epoch) */
  e: number;
  /** Cache tags (for distributed tag invalidation) */
  t?: string[];
  /** Timestamp when tags were attached (ms epoch) */
  ta?: number;
}

export interface CFCacheStoreOptions<TEnv = unknown> {
  /**
   * Cache namespace. If not provided, uses caches.default (recommended).
   * Only set this if you need isolated cache storage.
   */
  namespace?: string;

  /**
   * Base URL for cache keys.
   *
   * If not provided, derives from request hostname via requestContext:
   * - Production domains → uses `https://{hostname}/`
   * - Dev/preview (localhost, workers.dev, pages.dev) → uses internal fallback URL
   */
  baseUrl?: string;

  /** Default cache options */
  defaults?: CacheDefaults;

  /**
   * Cloudflare ExecutionContext for non-blocking cache writes.
   * Pass the `ctx` from your worker's fetch handler.
   *
   * @example
   * ```typescript
   * new CFCacheStore({ ctx: env.ctx })
   * ```
   */
  ctx: ExecutionContext;

  /**
   * Optional KV namespace for L2 cache persistence.
   *
   * When provided, KV acts as a global fallback behind the per-colo Cache API.
   * On L1 miss, KV is checked and hits are promoted back to L1.
   * On writes, data is persisted to both L1 and KV.
   *
   * @example
   * ```typescript
   * new CFCacheStore({ ctx: env.ctx, kv: env.CACHE_KV })
   * ```
   *
   * Tag-based invalidation (updateTag/revalidateTag) requires KV: the
   * tag-invalidation markers are stored in this same namespace. There is no
   * separate tag-invalidation store to configure.
   */
  kv?: KVNamespace;

  /**
   * Optional eager-purge hook, called ONCE per updateTag()/revalidateTag() with
   * the namespaced Cloudflare Cache-Tags to purge (one batched call for the
   * whole invalidation, not one per tag). These exactly match the `Cache-Tag`
   * header this store writes on its tag-lookup marker entries
   * (`rg:{namespace}:lk:{encodedTag}`), so forwarding them to Cloudflare's
   * purge-by-tag API evicts the cached lookups in every colo - making
   * cross-colo invalidation prompt instead of waiting out `tagCacheTtl`.
   *
   * Only meaningful with `tagCacheTtl > 0` (otherwise there are no cached
   * lookups to purge). The values are pre-encoded, so commas in tag names are
   * safe to pass straight to the purge API.
   *
   * @example
   * ```ts
   * onRevalidateTag: async (cacheTags) => {
   *   await fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE}/purge_cache`, {
   *     method: "POST",
   *     headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
   *     body: JSON.stringify({ tags: cacheTags }),
   *   });
   * }
   * ```
   */
  onRevalidateTag?: (cacheTags: string[]) => Promise<void>;

  /**
   * Optional expiration (seconds) for tag-invalidation markers in KV. A marker
   * must outlive every entry tagged before the invalidation, so this MUST
   * exceed your largest entry TTL+SWR. Defaults to no expiration (markers
   * persist; they are tiny - one timestamp per distinct invalidated tag).
   *
   * Note the opposite sizing from `tagCacheTtl` below: `tagInvalidationTtl` must
   * be LARGE (outlive data); `tagCacheTtl` should be SMALL (a staleness ceiling).
   *
   * Cardinality matters: each DISTINCT invalidated tag writes one permanent KV
   * marker (with the no-expiry default). Keep tags LOW-cardinality and never
   * derive an invalidation tag from untrusted input (e.g.
   * `revalidateTag(req.query.tag)`) - an attacker could otherwise grow your KV
   * namespace without bound. Set a `tagInvalidationTtl` only if your tags are
   * unavoidably high-cardinality AND it can still safely exceed your max entry
   * TTL+SWR.
   */
  tagInvalidationTtl?: number;

  /**
   * Optional TTL (seconds) for caching tag-invalidation markers in the per-colo
   * Cache API (L1), to avoid a KV marker read on every tagged cache read.
   *
   * Default `0` = disabled: the marker is read from KV on every tagged read
   * (today's behavior), giving the strongest cross-colo invalidation latency
   * (~KV consistency). A positive value caches each marker (including the
   * "no marker yet" state) in L1 for that many seconds, so within the window a
   * colo answers from L1 with no KV read.
   *
   * The colo that runs `updateTag`/`revalidateTag` writes the fresh marker
   * straight into its own L1 (write-through), so it observes the invalidation
   * immediately. By default OTHER colos only converge when their cached marker
   * expires, so `tagCacheTtl` is the MAXIMUM extra cross-colo invalidation
   * latency for them. Recommended 30-60 for high-read, low-mutation tags; leave
   * at 0 when prompt global invalidation matters and you cannot wire a purge.
   *
   * To make other colos prompt WITHOUT a short TTL, wire `onRevalidateTag` to a
   * Cloudflare purge-by-tag call: each marker entry carries a namespaced
   * `Cache-Tag`, and `onRevalidateTag` is handed exactly those tags to purge, so
   * the cached lookups are evicted everywhere on invalidation. With a purge
   * wired, `tagCacheTtl` becomes purely a read-cost reducer + fallback window
   * (safe to set large) rather than the invalidation-latency ceiling.
   */
  tagCacheTtl?: number;

  /**
   * Cache version string override. When this changes, all cached entries are
   * effectively invalidated (new keys won't match old entries).
   *
   * Defaults to the auto-generated VERSION from the `@rangojs/router:version` virtual module.
   * Only set this if you need a custom versioning strategy.
   */
  version?: string;

  /**
   * Custom key generator applied to all cache operations.
   * Receives the full RequestContext (including env) and the default-generated key.
   * Return value becomes the final cache key (unless route overrides with `key` option).
   *
   * Reserved prefixes: tag-invalidation markers live in the SAME KV namespace as
   * data, keyed `__tag__/<tag>` (and `__tagmarker__/<tag>` for the L1 cache). A
   * returned key must NOT begin with `__tag__/` or `__tagmarker__/`, or it can
   * collide with a tag marker and corrupt invalidation. The documented
   * prepend-style generators below are safe.
   *
   * @example Using headers for user segmentation
   * ```typescript
   * keyGenerator: (ctx, defaultKey) => {
   *   const segment = ctx.request.headers.get('x-user-segment') || 'default';
   *   return `${segment}:${defaultKey}`;
   * }
   * ```
   *
   * @example Using env bindings for multi-region
   * ```typescript
   * keyGenerator: (ctx, defaultKey) => {
   *   const region = ctx.env.REGION || 'us';
   *   return `${region}:${defaultKey}`;
   * }
   * ```
   *
   * @example Using cookies for locale-aware caching
   * ```typescript
   * keyGenerator: (ctx, defaultKey) => {
   *   const locale = cookies().get('locale')?.value || 'en';
   *   return `${locale}:${defaultKey}`;
   * }
   * ```
   */
  keyGenerator?: (
    ctx: RequestContext<TEnv>,
    defaultKey: string,
  ) => string | Promise<string>;
}

/**
 * Cache status values for the x-edge-cache-status header.
 * @internal
 */
export type CacheStatus = "HIT" | "REVALIDATING";

// ============================================================================
// CFCacheStore Implementation
// ============================================================================

export class CFCacheStore<TEnv = unknown> implements SegmentCacheStore<TEnv> {
  readonly defaults?: CacheDefaults;
  readonly keyGenerator?: (
    ctx: RequestContext<TEnv>,
    defaultKey: string,
  ) => string | Promise<string>;

  private readonly namespace?: string;
  private readonly baseUrl: string;
  private readonly waitUntil?: (fn: () => Promise<void>) => void;
  private readonly version?: string;
  private readonly kv?: KVNamespace;
  private readonly onRevalidateTag?: (tags: string[]) => Promise<void>;
  private readonly tagInvalidationTtl?: number;
  private readonly tagCacheTtl: number;

  constructor(options: CFCacheStoreOptions<TEnv>) {
    if (!options.ctx) {
      throw new Error(
        "[CFCacheStore] ExecutionContext (ctx) is required. " +
          "Pass the Cloudflare ExecutionContext from your worker's fetch handler: " +
          "new CFCacheStore({ ctx: env.ctx })",
      );
    }

    this.namespace = options.namespace;
    this.baseUrl = options.baseUrl ?? this.deriveBaseUrl();
    this.defaults = options.defaults;
    this.version = options.version ?? VERSION;
    this.keyGenerator = options.keyGenerator;
    this.waitUntil = (fn) => options.ctx.waitUntil(fn());
    this.kv = options.kv;
    this.onRevalidateTag = options.onRevalidateTag;
    this.tagInvalidationTtl = options.tagInvalidationTtl;
    this.tagCacheTtl = options.tagCacheTtl ?? 0;

    // Read-side tag invalidation requires KV: isGloballyInvalidated() compares an
    // entry's taggedAt against the per-tag KV marker and short-circuits to "not
    // invalidated" when no KV namespace is configured. A consumer who wires the
    // tag machinery (tagCacheTtl for L1 markers, or onRevalidateTag for CDN purge)
    // but omits kv gets markers written and the purge fired, yet every tagged read
    // still serves stale data with no other signal. Surface that misconfiguration.
    if (!this.kv && (this.tagCacheTtl > 0 || this.onRevalidateTag)) {
      const id = this.namespace ?? "default";
      if (!warnedNoKvReadInvalidation.has(id)) {
        warnedNoKvReadInvalidation.add(id);
        console.warn(
          `[CFCacheStore] tagCacheTtl/onRevalidateTag is configured without a KV ` +
            `namespace, so tag invalidation has NO read-side effect: tagged reads ` +
            `are never treated as invalidated and serve stale data. Configure ` +
            `{ kv } for distributed tag invalidation.`,
        );
      }
    }
  }

  /**
   * Derive base URL from request hostname via requestContext.
   * Uses internal fallback for dev/preview environments and untrusted hostnames.
   * @internal
   */
  private deriveBaseUrl(): string {
    const fallback = "https://rsc-cache.internal.com/";

    const ctx = _getRequestContext();
    if (!ctx?.request) {
      return fallback;
    }

    try {
      const url = new URL(ctx.request.url);
      const hostname = url.hostname;

      // Use fallback for dev/preview environments
      if (
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname.endsWith(".workers.dev") ||
        hostname.endsWith(".pages.dev")
      ) {
        return fallback;
      }

      // Validate hostname: must be a valid domain (alphanumeric, hyphens, dots)
      // to prevent host header injection into cache keys
      if (!/^[a-zA-Z0-9.-]+$/.test(hostname) || hostname.length > 253) {
        return fallback;
      }

      // Use actual hostname for production
      return `https://${hostname}/`;
    } catch {
      return fallback;
    }
  }

  /**
   * Get the cache instance - uses caches.default unless namespace is specified.
   * @internal
   */
  private getCache(): Cache | Promise<Cache> {
    if (this.namespace) {
      return caches.open(this.namespace);
    }
    return caches.default;
  }

  // ============================================================================
  // Segment Cache Methods
  // ============================================================================

  /**
   * Guard the segment tier against a `keyGenerator` that returns a key colliding
   * with a reserved tag-marker namespace: `__tag__/` (the KV marker key) or
   * `__tagmarker__/` (the L1 Cache API marker request). The item/doc tiers are
   * internally prefixed (`fn:`/`doc:`) so only the bare segment key can collide;
   * a collision would let a segment write clobber - or a segment read/delete
   * evict - a live tag marker, silently breaking invalidation. Report loudly
   * (so a misconfigured keyGenerator surfaces immediately) and treat the segment
   * operation as a miss/no-op rather than corrupting the marker namespace.
   * @internal
   */
  private isReservedSegmentKey(
    key: string,
    category: CacheErrorCategory,
  ): boolean {
    const reserved = key.startsWith(TAG_MARKER_PREFIX)
      ? TAG_MARKER_PREFIX
      : key.startsWith(TAG_MARKER_CACHE_PREFIX)
        ? TAG_MARKER_CACHE_PREFIX
        : null;
    if (!reserved) return false;
    reportCacheError(
      new Error(
        `segment key "${key}" collides with the reserved "${reserved}" ` +
          `tag-marker namespace; the operation is ignored. Fix the store ` +
          `keyGenerator so it does not produce keys with this prefix.`,
      ),
      category,
      "[CFCacheStore] reserved key",
    );
    return true;
  }

  /**
   * Get cached entry data by key.
   *
   * Handles SWR atomically:
   * - If stale and not already revalidating, marks as REVALIDATING and returns shouldRevalidate: true
   * - If already REVALIDATING (and recent), returns shouldRevalidate: false
   * - If fresh, returns shouldRevalidate: false
   *
   * On L1 miss, falls back to KV (L2) if configured.
   * KV hits are promoted to L1 in the background.
   */
  async get(key: string): Promise<CacheGetResult | null> {
    if (this.isReservedSegmentKey(key, "cache-read")) return null;
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(key);
      const response = await cache.match(request);

      if (!response) {
        return this.kvGetSegment(key);
      }

      // Tag invalidation: an entry whose tags were invalidated after it was
      // cached is treated as a miss, so the next render re-populates it.
      const tagInfo = this.readTagInfo(response.headers);
      if (await this.isGloballyInvalidated(tagInfo.tags, tagInfo.taggedAt)) {
        return null;
      }

      // Read status headers
      const status = response.headers.get(CACHE_STATUS_HEADER);
      const age = Number(response.headers.get("age") ?? "0");
      const staleAt = Number(
        response.headers.get(CACHE_STALE_AT_HEADER) ?? "0",
      );

      const isStale = staleAt > 0 && Date.now() > staleAt;
      const isRevalidating =
        status === "REVALIDATING" && age < MAX_REVALIDATION_INTERVAL;

      // Case 1: Fresh or already being revalidated - just return data
      if (!isStale || isRevalidating) {
        const data = await this.parseOrEvict<CachedEntryData>(
          () => response.json() as Promise<CachedEntryData>,
          () => cache.delete(request),
          "get",
        );
        return data === null ? null : { data, shouldRevalidate: false };
      }

      // Case 2: Stale and needs revalidation - atomically mark REVALIDATING
      const [b1, b2] = response.body!.tee();

      const headers = new Headers(response.headers);
      headers.set(CACHE_STATUS_HEADER, "REVALIDATING");

      // Blocking write - must complete before returning to prevent race
      await cache.put(
        request,
        new Response(b1, { status: response.status, headers }),
      );

      const data = await this.parseOrEvict<CachedEntryData>(
        () => new Response(b2).json() as Promise<CachedEntryData>,
        () => cache.delete(request),
        "get(revalidating)",
      );
      return data === null ? null : { data, shouldRevalidate: true };
    } catch (error) {
      reportCacheError(error, "cache-read", "[CFCacheStore] get");
      return null;
    }
  }

  /**
   * Store entry data with TTL and optional SWR window.
   * Uses waitUntil for non-blocking write when available.
   * When KV is configured, also persists to L2.
   */
  async set(
    key: string,
    data: CachedEntryData,
    ttl: number,
    swr?: number,
  ): Promise<void> {
    if (this.isReservedSegmentKey(key, "cache-write")) return;
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(key);

      // Extended TTL covers SWR window
      const swrWindow = resolveSwrWindow(swr, this.defaults);
      const totalTtl = ttl + swrWindow;
      const staleAt = Date.now() + ttl * 1000;

      // Stamp the tag timestamp at write time and carry it (with the tags)
      // into both the L1 body and the KV envelope so reads can run the
      // invalidation check.
      const taggedAt =
        data.tags && data.tags.length > 0 ? Date.now() : undefined;
      const dataToStore: CachedEntryData = taggedAt
        ? { ...data, taggedAt }
        : data;

      const body = JSON.stringify(dataToStore);
      const response = new Response(body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${totalTtl}`,
          [CACHE_STALE_AT_HEADER]: String(staleAt),
          [CACHE_STATUS_HEADER]: "HIT",
          ...this.tagHeaderEntries(dataToStore.tags, taggedAt),
        },
      });

      const putPromise = cache.put(request, response);

      if (this.waitUntil) {
        // Non-blocking write. These store-level background tasks intentionally
        // omit the reportingAsync ctx argument: the store is a request-agnostic
        // singleton and this.waitUntil is the execution context's, not a single
        // request's, so a failure is reported console-loud only (it cannot be
        // attributed to one request's onError). The request-scoped tag verbs
        // (revalidateTag / stale-revalidation) DO thread their captured ctx.
        this.waitUntil(() =>
          reportingAsync(
            () => putPromise,
            "cache-write",
            "[CFCacheStore] L1 write",
          ),
        );
      } else {
        // Blocking fallback
        await putPromise;
      }

      // L2: persist to KV
      this.kvSetSegment(key, dataToStore, staleAt, totalTtl, swrWindow);
    } catch (error) {
      reportCacheError(error, "cache-write", "[CFCacheStore] set");
    }
  }

  /**
   * Delete a cached entry from L1 and L2.
   */
  async delete(key: string): Promise<boolean> {
    if (this.isReservedSegmentKey(key, "cache-delete")) return false;
    try {
      const cache = await this.getCache();
      const result = await cache.delete(this.keyToRequest(key));

      // L2: delete from KV
      if (this.kv && this.waitUntil) {
        const kvKey = this.toKVKey(key);
        this.waitUntil(() =>
          reportingAsync(
            () => this.kv!.delete(kvKey),
            "cache-delete",
            "[CFCacheStore] delete L2",
          ),
        );
      }

      return result;
    } catch (error) {
      reportCacheError(error, "cache-delete", "[CFCacheStore] delete");
      return false;
    }
  }

  // ============================================================================
  // Document Cache Methods
  // ============================================================================

  /**
   * Get a cached Response by key (for document-level caching).
   * Returns the response and whether it should be revalidated (SWR).
   * Falls back to KV (L2) on L1 miss.
   */
  async getResponse(
    key: string,
  ): Promise<{ response: Response; shouldRevalidate: boolean } | null> {
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(`doc:${key}`);
      const response = await cache.match(request);

      if (!response || response.status !== 200) {
        return this.kvGetResponse(key);
      }

      // Tag invalidation check (treat invalidated entry as a miss).
      const tagInfo = this.readTagInfo(response.headers);
      if (await this.isGloballyInvalidated(tagInfo.tags, tagInfo.taggedAt)) {
        return null;
      }

      // Check staleness
      const staleAt = Number(response.headers.get(CACHE_STALE_AT_HEADER) || 0);
      const isStale = staleAt > 0 && Date.now() > staleAt;

      // L1 document bodies are streamed through verbatim - unlike the segment/
      // item tiers (which JSON-parse and so structurally detect corruption) and
      // the KV doc tier (validated in kvGetResponse, KV being the real partial-
      // read vector). Integrity here relies on the Cache API: cache.put stores a
      // response atomically or fails, so a truncated body is not served back. We
      // deliberately do NOT buffer+hash the body to re-verify it: that would
      // defeat streaming the document and add a full read to every cache hit.
      return {
        response: this.toClientResponse(response),
        shouldRevalidate: isStale,
      };
    } catch (error) {
      reportCacheError(error, "cache-read", "[CFCacheStore] getResponse");
      return null;
    }
  }

  /**
   * Strip internal edge headers and restore the author's Cache-Control before a
   * cached document Response is served to a client. L1 entries carry the
   * internal staleness/status headers and a rewritten Cache-Control; none of
   * those should reach the browser or an upstream CDN.
   */
  private toClientResponse(response: Response): Response {
    const headers = new Headers(response.headers);
    const originalCacheControl = headers.get(CACHE_ORIG_CC_HEADER);
    if (originalCacheControl !== null) {
      headers.set("Cache-Control", originalCacheControl);
    } else {
      headers.delete("Cache-Control");
    }
    headers.delete(CACHE_ORIG_CC_HEADER);
    headers.delete(CACHE_STALE_AT_HEADER);
    headers.delete(CACHE_STATUS_HEADER);
    headers.delete(CACHE_TAGS_HEADER);
    headers.delete(CACHE_TAGGED_AT_HEADER);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  /**
   * Store a Response with TTL and optional SWR window (for document-level caching).
   * When KV is configured, also persists to L2.
   */
  async putResponse(
    key: string,
    response: Response,
    ttl: number,
    swr?: number,
    tags?: string[],
  ): Promise<void> {
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(`doc:${key}`);

      // Extended TTL covers SWR window
      const swrWindow = resolveSwrWindow(swr, this.defaults);
      const totalTtl = ttl + swrWindow;
      const staleAt = Date.now() + ttl * 1000;
      const taggedAt = tags && tags.length > 0 ? Date.now() : undefined;

      // Clone body for potential KV write before consuming it for L1
      const [l1Body, kvBody] = this.kv
        ? response.body
          ? response.body.tee()
          : [null, null]
        : [response.body, null];

      // Clone and add cache headers. The author's Cache-Control is stashed and
      // replaced with a long max-age so the CF Cache API holds the entry across
      // the SWR window; getResponse restores the original before serving.
      const headers = new Headers(response.headers);
      const originalCacheControl = response.headers.get("Cache-Control");
      if (originalCacheControl !== null) {
        headers.set(CACHE_ORIG_CC_HEADER, originalCacheControl);
      }
      headers.set("Cache-Control", `public, max-age=${totalTtl}`);
      headers.set(CACHE_STALE_AT_HEADER, String(staleAt));
      // Internal tag headers (stripped by toClientResponse before serving).
      const tagHeaders = this.tagHeaderEntries(tags, taggedAt);
      for (const [name, value] of Object.entries(tagHeaders)) {
        headers.set(name, value);
      }

      const toCache = new Response(l1Body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });

      const putPromise = cache.put(request, toCache);

      if (this.waitUntil) {
        // Non-blocking write
        this.waitUntil(() =>
          reportingAsync(
            () => putPromise,
            "cache-write",
            "[CFCacheStore] L1 write",
          ),
        );
      } else {
        // Blocking fallback
        await putPromise;
      }

      // L2: persist to KV (KV requires expirationTtl >= 60s)
      if (this.kv && this.waitUntil && totalTtl >= 60) {
        const kvKey = this.toKVKey(`doc:${key}`);
        const headersArray: [string, string][] = [];
        response.headers.forEach((v, k) => headersArray.push([k, v]));
        // Read body as ArrayBuffer and encode to base64 to preserve binary payloads
        const bodyBuf = kvBody
          ? await new Response(kvBody).arrayBuffer()
          : new ArrayBuffer(0);
        const bodyBase64 = bufferToBase64(bodyBuf);

        this.waitUntil(() =>
          reportingAsync(
            () => {
              const envelope: KVResponseEnvelope = {
                b: bodyBase64,
                st: response.status,
                stx: response.statusText,
                hd: headersArray,
                s: staleAt,
                e: staleAt + swrWindow * 1000,
                t: tags,
                ta: taggedAt,
              };
              return this.kv!.put(kvKey, JSON.stringify(envelope), {
                expirationTtl: totalTtl,
              });
            },
            "cache-write",
            "[CFCacheStore] kvPutResponse",
          ),
        );
      }
    } catch (error) {
      reportCacheError(error, "cache-write", "[CFCacheStore] putResponse");
    }
  }

  // ============================================================================
  // Function Cache Methods (for "use cache" directive)
  // ============================================================================

  /**
   * Get a cached function result by key.
   * Follows the same SWR pattern as get() for segment caching.
   * Falls back to KV (L2) on L1 miss.
   */
  async getItem(key: string): Promise<CacheItemResult | null> {
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(`fn:${key}`);
      const response = await cache.match(request);

      if (!response) return this.kvGetItem(key);

      // Tag invalidation check (treat invalidated entry as a miss).
      const tagInfo = this.readTagInfo(response.headers);
      if (await this.isGloballyInvalidated(tagInfo.tags, tagInfo.taggedAt)) {
        return null;
      }

      const staleAt = Number(
        response.headers.get(CACHE_STALE_AT_HEADER) ?? "0",
      );
      const status = response.headers.get(CACHE_STATUS_HEADER);
      const age = Number(response.headers.get("age") ?? "0");

      const isStale = staleAt > 0 && Date.now() > staleAt;
      const isRevalidating =
        status === "REVALIDATING" && age < MAX_REVALIDATION_INTERVAL;

      const data = await this.parseOrEvict<{
        value: string;
        handles?: Record<string, Record<string, unknown[]>>;
      }>(
        () =>
          response.json() as Promise<{
            value: string;
            handles?: Record<string, Record<string, unknown[]>>;
          }>,
        () => cache.delete(request),
        "getItem",
      );
      if (data === null) return null;

      if (!isStale || isRevalidating) {
        return {
          value: data.value,
          handles: data.handles,
          shouldRevalidate: false,
          tags: tagInfo.tags,
        };
      }

      // Stale and needs revalidation — mark REVALIDATING atomically
      const headers = new Headers(response.headers);
      headers.set(CACHE_STATUS_HEADER, "REVALIDATING");
      await cache.put(
        request,
        new Response(JSON.stringify(data), { status: 200, headers }),
      );

      return {
        value: data.value,
        handles: data.handles,
        shouldRevalidate: true,
        tags: tagInfo.tags,
      };
    } catch (error) {
      reportCacheError(error, "cache-read", "[CFCacheStore] getItem");
      return null;
    }
  }

  /**
   * Store a function result with TTL and optional SWR window.
   * When KV is configured, also persists to L2.
   */
  async setItem(
    key: string,
    value: string,
    options?: CacheItemOptions,
  ): Promise<void> {
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(`fn:${key}`);

      const ttl = resolveTtl(options?.ttl, this.defaults, DEFAULT_FUNCTION_TTL);
      const swrWindow = resolveSwrWindow(options?.swr, this.defaults);
      const totalTtl = ttl + swrWindow;
      const staleAt = Date.now() + ttl * 1000;

      const tags = options?.tags;
      const taggedAt = tags && tags.length > 0 ? Date.now() : undefined;

      const body = JSON.stringify({ value, handles: options?.handles });
      const response = new Response(body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${totalTtl}`,
          [CACHE_STALE_AT_HEADER]: String(staleAt),
          [CACHE_STATUS_HEADER]: "HIT",
          ...this.tagHeaderEntries(tags, taggedAt),
        },
      });

      const putPromise = cache.put(request, response);

      if (this.waitUntil) {
        this.waitUntil(() =>
          reportingAsync(
            () => putPromise,
            "cache-write",
            "[CFCacheStore] L1 write",
          ),
        );
      } else {
        await putPromise;
      }

      // L2: persist to KV (KV requires expirationTtl >= 60s)
      if (this.kv && this.waitUntil && totalTtl >= 60) {
        const kvKey = this.toKVKey(`fn:${key}`);
        this.waitUntil(() =>
          reportingAsync(
            () => {
              const envelope: KVItemEnvelope = {
                v: value,
                h: options?.handles,
                s: staleAt,
                e: staleAt + swrWindow * 1000,
                t: tags,
                ta: taggedAt,
              };
              return this.kv!.put(kvKey, JSON.stringify(envelope), {
                expirationTtl: totalTtl,
              });
            },
            "cache-write",
            "[CFCacheStore] kvSetItem",
          ),
        );
      }
    } catch (error) {
      reportCacheError(error, "cache-write", "[CFCacheStore] setItem");
    }
  }

  // ============================================================================
  // Key Helpers
  // ============================================================================

  /**
   * Convert string key to Request object for CF Cache API.
   * Includes version in URL if specified (for cache invalidation on code changes).
   * @internal
   */
  private keyToRequest(key: string): Request {
    const encodedKey = encodeURIComponent(key);
    // Include version in URL path to invalidate cache when version changes
    const versionPath = this.version ? `v/${this.version}/` : "";
    return new Request(`${this.baseUrl}${versionPath}${encodedKey}`, {
      method: "GET",
    });
  }

  /**
   * Convert string key to KV key string.
   * Uses same version prefix as Cache API for consistent invalidation.
   * @internal
   */
  private toKVKey(key: string): string {
    const versionPath = this.version ? `v/${this.version}/` : "";
    return `${versionPath}${key}`;
  }

  /**
   * Parse a stored entry, EVICTING it if the parse fails. A parse failure means
   * the entry is corrupt or partial (truncated Cache API body, malformed KV
   * envelope/base64) - it would deterministically fail every future read - so it
   * is deleted to self-heal (the next read misses and re-renders) and reported as
   * cache-corrupt. This is distinct from a transient infra error (the caller's
   * outer catch reports cache-read and does NOT delete a still-good entry).
   * Returns null on corruption; the caller treats null as a miss.
   * @internal
   */
  private async parseOrEvict<T>(
    parse: () => Promise<T> | T,
    evict: () => Promise<unknown>,
    label: string,
  ): Promise<T | null> {
    try {
      return await parse();
    } catch (error) {
      reportCacheError(
        error,
        "cache-corrupt",
        `[CFCacheStore] ${label}: corrupt/partial entry, evicting`,
      );
      try {
        await evict();
      } catch (evictError) {
        reportCacheError(
          evictError,
          "cache-delete",
          `[CFCacheStore] ${label}: evicting corrupt entry failed`,
        );
      }
      return null;
    }
  }

  /**
   * Best-effort delete of a single KV key, reporting (not swallowing) a delete
   * failure as cache-delete. Used by the corrupt-entry self-heal paths.
   * @internal
   */
  private async evictKvKey(kvKey: string, label: string): Promise<void> {
    try {
      await this.kv!.delete(kvKey);
    } catch (error) {
      reportCacheError(
        error,
        "cache-delete",
        `[CFCacheStore] ${label}: evict failed`,
      );
    }
  }

  /**
   * KV-get a JSON envelope, EVICTING the key only when it is genuinely corrupt.
   *
   * Reads as { type: "text" }, NOT { type: "json" }, on purpose: the "json" form
   * fuses the network read and the JSON parse, so a transient KV outage (5xx/429/
   * network blip) is indistinguishable from a malformed body and would delete a
   * still-good cross-colo entry - a self-inflicted miss storm. Reading text lets a
   * transient read error propagate to the caller's outer catch (reported
   * cache-read, the entry left intact); only a JSON.parse failure on a body that
   * WAS successfully read - or an envelope that parses but fails `validate`
   * (fields missing from a truncated write) - is true corruption that evicts +
   * reports cache-corrupt. A MISSING key (kv.get -> null) is a normal miss.
   * @internal
   */
  private async kvGetOrEvict<T>(
    kvKey: string,
    validate: (envelope: T) => boolean,
    label: string,
  ): Promise<T | null> {
    // A transient error here throws and is reported cache-read (no eviction) by
    // the caller's outer catch - deliberately NOT caught as corruption.
    const text = await this.kv!.get(kvKey, { type: "text" });
    if (text == null) return null; // missing key = miss, not corruption

    let raw: T;
    try {
      raw = JSON.parse(text) as T;
    } catch (error) {
      reportCacheError(
        error,
        "cache-corrupt",
        `[CFCacheStore] ${label}: corrupt JSON in KV, evicting`,
      );
      await this.evictKvKey(kvKey, label);
      return null;
    }

    if (!validate(raw)) {
      reportCacheError(
        new Error("malformed/partial KV envelope"),
        "cache-corrupt",
        `[CFCacheStore] ${label}: malformed envelope, evicting`,
      );
      await this.evictKvKey(kvKey, label);
      return null;
    }
    return raw;
  }

  // ============================================================================
  // Tag Invalidation (single-store: markers live in this.kv)
  // ============================================================================

  /** KV key for a tag's invalidation marker. */
  private tagMarkerKey(tag: string): string {
    return this.toKVKey(`${TAG_MARKER_PREFIX}${tag}`);
  }

  /**
   * Header entries carrying an entry's tags (JSON-encoded, comma-safe) and the
   * timestamp they were attached. Returns an empty object when there are no
   * tags so untagged entries stay header-free and skip the invalidation check.
   */
  private tagHeaderEntries(
    tags: string[] | undefined,
    taggedAt: number | undefined,
  ): Record<string, string> {
    if (!tags || tags.length === 0 || !taggedAt) return {};
    return {
      // encodeURIComponent so the value is pure ASCII: HTTP header values are
      // ByteStrings, but JSON.stringify leaves codepoints > U+00FF (emoji/CJK)
      // verbatim, which makes new Response({ headers }) throw and the outer
      // try/catch silently drop the whole entry from cache. Decoded in
      // readTagInfo. The L1 marker Cache-Tag path encodes for the same reason.
      [CACHE_TAGS_HEADER]: encodeURIComponent(JSON.stringify(tags)),
      [CACHE_TAGGED_AT_HEADER]: String(taggedAt),
    };
  }

  /** Read an entry's tags/taggedAt back from its headers. */
  private readTagInfo(headers: Headers): {
    tags?: string[];
    taggedAt?: number;
  } {
    const rawTags = headers.get(CACHE_TAGS_HEADER);
    const rawTaggedAt = headers.get(CACHE_TAGGED_AT_HEADER);
    if (!rawTags || !rawTaggedAt) return {};
    try {
      return {
        tags: JSON.parse(decodeURIComponent(rawTags)) as string[],
        taggedAt: Number(rawTaggedAt),
      };
    } catch {
      return {};
    }
  }

  /**
   * Whether an entry tagged at `taggedAt` with `tags` has been invalidated since.
   * Reads the per-tag invalidation markers from KV and returns true if any tag's
   * latest invalidation is at or after taggedAt (>= so a same-millisecond
   * invalidate wins, favouring freshness over staleness). Fails open: KV errors
   * never turn a hit into a wrongful miss-storm beyond this single read.
   */
  private async isGloballyInvalidated(
    tags: string[] | undefined,
    taggedAt: number | undefined,
  ): Promise<boolean> {
    if (!this.kv || !tags || tags.length === 0 || !taggedAt) return false;
    const ctx = _getRequestContext();
    const memo = ctx ? getTagMarkerMemo(ctx) : undefined;
    const inflight = ctx ? getTagMarkerInflight(ctx) : undefined;
    try {
      const markers = await Promise.all(
        tags.map((tag) => this.readTagMarker(tag, memo, inflight)),
      );
      for (const marker of markers) {
        if (marker != null && marker >= taggedAt) return true;
      }
      return false;
    } catch (error) {
      reportCacheError(
        error,
        "cache-read",
        "[CFCacheStore] tag invalidation check",
      );
      return false;
    }
  }

  /** Synthetic Cache API request for a tag's L1-cached invalidation marker. */
  private tagMarkerRequest(tag: string): Request {
    return this.keyToRequest(`${TAG_MARKER_CACHE_PREFIX}${tag}`);
  }

  /**
   * Read a tag's latest invalidation timestamp (or null if never invalidated)
   * through the cascade: per-request memo -> per-colo L1 cache (only when
   * tagCacheTtl > 0) -> KV (the global truth). The memo is always consulted
   * first so it stays authoritative within a request (read-your-own-writes),
   * and every KV/L1 result is written back into the memo. A Cache API miss
   * always falls through to KV; absence is represented by a cached sentinel,
   * never by a miss.
   *
   * Concurrent reads of the same tag within a request share one in-flight read
   * (the resolved-value memo only collapses sequential reads; parallel segment
   * loading would otherwise issue one KV read per concurrent reader).
   * @internal
   */
  private async readTagMarker(
    tag: string,
    memo: Map<string, number | null> | undefined,
    inflight: Map<string, Promise<number | null>> | undefined,
  ): Promise<number | null> {
    if (memo && memo.has(tag)) return memo.get(tag) ?? null;

    // Collapse concurrent (not-yet-resolved) reads of this tag onto one promise.
    if (inflight) {
      const pending = inflight.get(tag);
      if (pending) return pending;
      const read = this.fetchTagMarker(tag, memo);
      inflight.set(tag, read);
      try {
        return await read;
      } finally {
        // Resolved values now live in the memo; drop the in-flight entry.
        inflight.delete(tag);
      }
    }

    return this.fetchTagMarker(tag, memo);
  }

  /**
   * Uncached body of readTagMarker: L1 (per-colo Cache API, opt-in via
   * tagCacheTtl) -> KV. Writes the resolved value back into the memo.
   * @internal
   */
  private async fetchTagMarker(
    tag: string,
    memo: Map<string, number | null> | undefined,
  ): Promise<number | null> {
    // L1 (per-colo) marker cache - opt-in via tagCacheTtl.
    if (this.tagCacheTtl > 0) {
      try {
        const cache = await this.getCache();
        const hit = await cache.match(this.tagMarkerRequest(tag));
        if (hit) {
          const body = await hit.text();
          const value = body === TAG_MARKER_ABSENT ? null : Number(body);
          memo?.set(tag, value);
          return value;
        }
      } catch {
        // Fall through to KV on any L1 read error.
      }
    }

    // KV (global truth).
    const raw = await this.kv!.get(this.tagMarkerKey(tag), { type: "text" });
    const value = raw != null ? Number(raw) : null;
    memo?.set(tag, value);

    // Populate L1 for subsequent reads in this colo (non-blocking).
    if (this.tagCacheTtl > 0) {
      const put = () => this.putTagMarkerL1(tag, value);
      if (this.waitUntil) this.waitUntil(put);
      else void put();
    }
    return value;
  }

  /**
   * Cloudflare Cache-Tags written on a tag's L1 marker entry, namespaced per
   * store so purges never collide with other Cache-Tags in the zone. Three
   * tiers, broad to specific:
   *   rg:{ns}            - everything this store cached (deploy/nuclear reset)
   *   rg:{ns}:lk         - all tag-lookup markers
   *   rg:{ns}:lk:{tag}   - this tag's lookup (the normal updateTag purge target)
   * The tag value is encodeURIComponent'd so commas/spaces can't corrupt the
   * comma-delimited Cache-Tag header.
   * @internal
   */
  private lookupCacheTags(tag: string): string[] {
    const ns = this.namespace ?? "default";
    return [`rg:${ns}`, `rg:${ns}:lk`, this.lookupPurgeTag(tag)];
  }

  /** The specific Cache-Tag a consumer purges to evict tag `tag`'s lookup. */
  private lookupPurgeTag(tag: string): string {
    const ns = this.namespace ?? "default";
    return `rg:${ns}:lk:${encodeURIComponent(tag)}`;
  }

  /**
   * Write a tag marker value into the per-colo L1 Cache API with tagCacheTtl.
   * `null` is stored as the TAG_MARKER_ABSENT sentinel so "no marker yet" is
   * cacheable (most tags are never invalidated - that is where the read savings
   * come from). The entry also carries a namespaced Cache-Tag so an external
   * purge-by-tag (via onRevalidateTag) can evict it across colos promptly,
   * rather than waiting out tagCacheTtl. Best-effort.
   * @internal
   */
  private async putTagMarkerL1(
    tag: string,
    value: number | null,
  ): Promise<void> {
    if (this.tagCacheTtl <= 0) return;
    try {
      const cache = await this.getCache();
      const body = value != null ? String(value) : TAG_MARKER_ABSENT;
      await cache.put(
        this.tagMarkerRequest(tag),
        new Response(body, {
          headers: {
            "Cache-Control": `public, max-age=${this.tagCacheTtl}`,
            "Cache-Tag": this.lookupCacheTags(tag).join(","),
          },
        }),
      );
    } catch {
      // Best-effort: a failed L1 populate just means the next read consults KV.
    }
  }

  /**
   * Invalidate every entry tagged with any of `tags`. Receives the whole batch
   * from one updateTag()/revalidateTag() call so the eager-purge hook fires
   * ONCE (one CDN purge request, not one per tag). For each tag: records the KV
   * marker (the durable cross-colo truth that reads compare taggedAt against),
   * writes the fresh marker straight into this colo's L1 (write-through, NOT
   * delete - a delete would let the next read re-read a not-yet-converged KV
   * value and re-arm the stale window), and memoizes it for same-request
   * read-your-own-writes. Finally fires onRevalidateTag with the namespaced
   * lookup Cache-Tags so a consumer purge evicts the cached lookups in other
   * colos promptly (otherwise they converge within tagCacheTtl).
   *
   * Durable-write integrity: the in-memory write-through (memo + L1) for a tag
   * runs ONLY after that tag's KV marker write is confirmed. If any KV write
   * fails (transient error, or an over-512-byte key), this rejects with the
   * failed tags so an awaiting updateTag() surfaces the failure instead of
   * silently reporting success while other requests/colos serve stale data. The
   * eager purge still fires for the whole batch first (it is additive).
   */
  async invalidateTags(tags: string[]): Promise<void> {
    if (tags.length === 0) return;
    const invalidatedAt = Date.now();
    const ctx = _getRequestContext();
    const memo = ctx ? getTagMarkerMemo(ctx) : undefined;

    if (!this.kv && !this.onRevalidateTag) {
      console.warn(
        `[CFCacheStore] invalidateTags had no effect: configure a KV namespace ` +
          `for distributed invalidation, or an onRevalidateTag hook.`,
      );
    }

    const failedTags = new Set<string>();
    const errors: unknown[] = [];
    if (this.kv) {
      await Promise.all(
        tags.map(async (tag) => {
          const markerKey = this.tagMarkerKey(tag);
          if (kvKeyByteLength(markerKey) > KV_MAX_KEY_BYTES) {
            failedTags.add(tag);
            errors.push(
              new Error(
                `tag "${tag}" produces a ${kvKeyByteLength(markerKey)}-byte KV ` +
                  `marker key, over the ${KV_MAX_KEY_BYTES}-byte limit`,
              ),
            );
            return;
          }
          try {
            await this.kv!.put(markerKey, String(invalidatedAt), {
              ...(this.tagInvalidationTtl
                ? { expirationTtl: this.tagInvalidationTtl }
                : {}),
            });
          } catch (error) {
            failedTags.add(tag);
            errors.push(error);
          }
        }),
      );
    }

    // Write-through memo + L1 only for tags with a confirmed durable marker (or
    // for every tag when there is no KV at all - a purge-only/dev config, where
    // the in-memory write-through is the only invalidation signal there is). The
    // memo write is synchronous (read-your-own-writes); the L1 Cache API writes
    // are independent, so fan them out in parallel rather than awaiting each.
    const l1Writes: Promise<void>[] = [];
    for (const tag of tags) {
      if (failedTags.has(tag)) continue;
      memo?.set(tag, invalidatedAt);
      if (this.tagCacheTtl > 0) {
        l1Writes.push(this.putTagMarkerL1(tag, invalidatedAt));
      }
    }
    if (l1Writes.length > 0) await Promise.all(l1Writes);

    // One batched eager purge of the lookup markers for the whole call. Fired
    // regardless of KV write outcome (it is additive and uses pure string ops).
    if (this.onRevalidateTag) {
      try {
        await this.onRevalidateTag(tags.map((tag) => this.lookupPurgeTag(tag)));
      } catch (error) {
        reportCacheError(
          error,
          "cache-invalidate",
          "[CFCacheStore] onRevalidateTag hook",
        );
      }
    }

    if (failedTags.size > 0) {
      const err = new Error(
        `[CFCacheStore] ${failedTags.size}/${tags.length} tag marker write(s) ` +
          `failed: ${[...failedTags].join(", ")}. Those tags may still serve ` +
          `stale data across requests/colos; retry the invalidation.`,
      );
      (err as Error & { cause?: unknown }).cause = errors[0];
      throw err;
    }
  }

  // ============================================================================
  // KV L2 Helpers
  // ============================================================================

  /**
   * KV fallback for segment cache reads.
   * Returns null if KV is not configured, entry is missing, or expired.
   * Promotes hits to L1 via waitUntil.
   * @internal
   */
  private async kvGetSegment(key: string): Promise<CacheGetResult | null> {
    if (!this.kv) return null;

    try {
      const kvKey = this.toKVKey(key);
      const envelope = await this.kvGetOrEvict<KVSegmentEnvelope>(
        kvKey,
        (e) =>
          typeof e.e === "number" && typeof e.s === "number" && e.d != null,
        "kvGetSegment",
      );
      if (!envelope) return null;

      const now = Date.now();

      // Hard-expired — treat as miss
      if (now > envelope.e) return null;

      // Tag invalidation check (also covers the KV tier, not just L1).
      if (
        await this.isGloballyInvalidated(envelope.d.tags, envelope.d.taggedAt)
      ) {
        return null;
      }

      const shouldRevalidate = now > envelope.s;

      // Promote to L1 in background
      this.promoteSegmentToL1(key, envelope);

      return { data: envelope.d, shouldRevalidate };
    } catch (error) {
      reportCacheError(error, "cache-read", "[CFCacheStore] kvGetSegment");
      return null;
    }
  }

  /**
   * Write segment data to KV.
   * @internal
   */
  private kvSetSegment(
    key: string,
    data: CachedEntryData,
    staleAt: number,
    totalTtl: number,
    swrWindow: number,
  ): void {
    // KV requires expirationTtl >= 60s. Skip write for short-lived entries.
    if (!this.kv || !this.waitUntil || totalTtl < 60) return;

    const kvKey = this.toKVKey(key);
    const expiresAt = staleAt + swrWindow * 1000;

    this.waitUntil(() =>
      reportingAsync(
        () => {
          const envelope: KVSegmentEnvelope = {
            d: data,
            s: staleAt,
            e: expiresAt,
          };
          return this.kv!.put(kvKey, JSON.stringify(envelope), {
            expirationTtl: totalTtl,
          });
        },
        "cache-write",
        "[CFCacheStore] kvSetSegment",
      ),
    );
  }

  /**
   * Promote segment data from KV to L1 Cache API.
   * @internal
   */
  private promoteSegmentToL1(key: string, envelope: KVSegmentEnvelope): void {
    if (!this.waitUntil) return;

    this.waitUntil(() =>
      reportingAsync(
        async () => {
          const now = Date.now();
          const remainingTtl = Math.max(
            1,
            Math.floor((envelope.e - now) / 1000),
          );
          const cache = await this.getCache();
          const request = this.keyToRequest(key);

          const response = new Response(JSON.stringify(envelope.d), {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": `public, max-age=${remainingTtl}`,
              [CACHE_STALE_AT_HEADER]: String(envelope.s),
              [CACHE_STATUS_HEADER]: "HIT",
              // Preserve tags across KV->L1 promotion so the promoted entry
              // stays tag-invalidatable.
              ...this.tagHeaderEntries(envelope.d.tags, envelope.d.taggedAt),
            },
          });

          await cache.put(request, response);
        },
        "cache-write",
        "[CFCacheStore] promoteSegmentToL1",
      ),
    );
  }

  /**
   * KV fallback for function cache reads.
   * @internal
   */
  private async kvGetItem(key: string): Promise<CacheItemResult | null> {
    if (!this.kv) return null;

    try {
      const kvKey = this.toKVKey(`fn:${key}`);
      const envelope = await this.kvGetOrEvict<KVItemEnvelope>(
        kvKey,
        (e) =>
          typeof e.v === "string" &&
          typeof e.e === "number" &&
          typeof e.s === "number",
        "kvGetItem",
      );
      if (!envelope) return null;

      const now = Date.now();

      if (now > envelope.e) return null;

      // Tag invalidation check (also covers the KV tier, not just L1).
      if (await this.isGloballyInvalidated(envelope.t, envelope.ta)) {
        return null;
      }

      const shouldRevalidate = now > envelope.s;

      // Promote to L1
      this.promoteItemToL1(key, envelope);

      return {
        value: envelope.v,
        handles: envelope.h,
        shouldRevalidate,
        tags: envelope.t,
      };
    } catch (error) {
      reportCacheError(error, "cache-read", "[CFCacheStore] kvGetItem");
      return null;
    }
  }

  /**
   * Promote function cache data from KV to L1.
   * @internal
   */
  private promoteItemToL1(key: string, envelope: KVItemEnvelope): void {
    if (!this.waitUntil) return;

    this.waitUntil(() =>
      reportingAsync(
        async () => {
          const now = Date.now();
          const remainingTtl = Math.max(
            1,
            Math.floor((envelope.e - now) / 1000),
          );
          const cache = await this.getCache();
          const request = this.keyToRequest(`fn:${key}`);

          const body = JSON.stringify({
            value: envelope.v,
            handles: envelope.h,
          });
          const response = new Response(body, {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": `public, max-age=${remainingTtl}`,
              [CACHE_STALE_AT_HEADER]: String(envelope.s),
              [CACHE_STATUS_HEADER]: "HIT",
              // Preserve tags across KV->L1 promotion (the item tier previously
              // dropped them, permanently disabling tag invalidation here).
              ...this.tagHeaderEntries(envelope.t, envelope.ta),
            },
          });

          await cache.put(request, response);
        },
        "cache-write",
        "[CFCacheStore] promoteItemToL1",
      ),
    );
  }

  /**
   * KV fallback for document cache reads.
   * @internal
   */
  private async kvGetResponse(
    key: string,
  ): Promise<{ response: Response; shouldRevalidate: boolean } | null> {
    if (!this.kv) return null;

    try {
      const kvKey = this.toKVKey(`doc:${key}`);
      const envelope = await this.kvGetOrEvict<KVResponseEnvelope>(
        kvKey,
        (e) =>
          typeof e.b === "string" &&
          typeof e.st === "number" &&
          typeof e.e === "number" &&
          typeof e.s === "number" &&
          Array.isArray(e.hd),
        "kvGetResponse",
      );
      if (!envelope) return null;

      const now = Date.now();

      if (now > envelope.e) return null;

      // Tag invalidation check (also covers the KV tier, not just L1).
      if (await this.isGloballyInvalidated(envelope.t, envelope.ta)) {
        return null;
      }

      const shouldRevalidate = now > envelope.s;

      // Reconstruct Response: decode base64 -> binary, rebuild headers/status.
      // Corrupt/partial base64 throws in atob; malformed `hd` or an out-of-range
      // `st` throws in new Headers/new Response. Any of these is a faulty entry,
      // so evict it and miss rather than re-failing every read until TTL.
      let response: Response;
      try {
        const bodyBuffer = base64ToBuffer(envelope.b);
        const headers = new Headers(envelope.hd);
        response = new Response(bodyBuffer, {
          status: envelope.st,
          statusText: envelope.stx,
          headers,
        });
      } catch (error) {
        reportCacheError(
          error,
          "cache-corrupt",
          "[CFCacheStore] kvGetResponse: corrupt response envelope, evicting",
        );
        await this.evictKvKey(kvKey, "kvGetResponse");
        return null;
      }

      // Promote to L1
      this.promoteResponseToL1(key, envelope);

      return { response, shouldRevalidate };
    } catch (error) {
      reportCacheError(error, "cache-read", "[CFCacheStore] kvGetResponse");
      return null;
    }
  }

  /**
   * Promote document cache data from KV to L1.
   * @internal
   */
  private promoteResponseToL1(key: string, envelope: KVResponseEnvelope): void {
    if (!this.waitUntil) return;

    this.waitUntil(() =>
      reportingAsync(
        async () => {
          const now = Date.now();
          const remainingTtl = Math.max(
            1,
            Math.floor((envelope.e - now) / 1000),
          );
          const cache = await this.getCache();
          const request = this.keyToRequest(`doc:${key}`);

          const headers = new Headers(envelope.hd);
          const originalCacheControl = headers.get("Cache-Control");
          if (originalCacheControl !== null) {
            headers.set(CACHE_ORIG_CC_HEADER, originalCacheControl);
          }
          headers.set("Cache-Control", `public, max-age=${remainingTtl}`);
          headers.set(CACHE_STALE_AT_HEADER, String(envelope.s));
          // Re-attach the internal tag headers (envelope.hd is client-facing
          // and intentionally excludes them) so the promoted entry stays
          // invalidatable.
          const tagHeaders = this.tagHeaderEntries(envelope.t, envelope.ta);
          for (const [name, value] of Object.entries(tagHeaders)) {
            headers.set(name, value);
          }

          const bodyBuffer = base64ToBuffer(envelope.b);
          const response = new Response(bodyBuffer, {
            status: envelope.st,
            statusText: envelope.stx,
            headers,
          });

          await cache.put(request, response);
        },
        "cache-write",
        "[CFCacheStore] promoteResponseToL1",
      ),
    );
  }
}

// ============================================================================
// Base64 Helpers (binary-safe response body encoding for KV)
// ============================================================================

/** Encode ArrayBuffer to base64 string. */
function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/** Decode base64 string to ArrayBuffer. */
function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
