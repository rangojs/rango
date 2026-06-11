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

// ============================================================================
// Constants
// ============================================================================

/** Header storing timestamp when entry becomes stale */
export const CACHE_STALE_AT_HEADER = "x-edge-cache-stale-at";

/** Header storing cache status: HIT | REVALIDATING */
export const CACHE_STATUS_HEADER = "x-edge-cache-status";

/**
 * Header storing the epoch-ms timestamp when an entry was marked REVALIDATING.
 * The SWR thundering-herd guard reads this to decide whether the in-flight
 * revalidation is still recent. It replaces a prior reliance on the HTTP `Age`
 * header: CF's Cache API does not populate `Age` reliably per-colo (and our own
 * unit MockCache never set it), so an absent `Age` defaulted to 0 and made every
 * REVALIDATING entry look "just revalidated" forever -- a dropped/never-finished
 * background revalidation could then pin an entry stale until hard expiry. An
 * explicit timestamp we write ourselves (same pattern as CACHE_STALE_AT_HEADER)
 * is reliable and lets the MAX_REVALIDATION_INTERVAL re-arm actually fire.
 */
export const CACHE_REVALIDATING_AT_HEADER = "x-edge-cache-revalidating-at";

/**
 * Header storing the absolute epoch-ms hard-expiry deadline (staleAt +
 * swrWindow*1000) of an L1 entry. The stale-path REVALIDATING re-put reads this
 * to recompute a SHRINKING Cache-Control max-age instead of copying set()'s
 * original full-window max-age. Without it, every MAX_REVALIDATION_INTERVAL
 * re-arm re-puts the full window and restarts CF's retention clock, pinning a
 * perpetually-stale entry (one whose background revalidation keeps failing) past
 * its intended hard-expiry indefinitely. Mirrors the KVSegmentEnvelope `e`
 * field and the remaining-ttl math in promoteSegmentToL1/promoteItemToL1.
 * @internal
 */
const CACHE_EXPIRES_AT_HEADER = "x-edge-cache-expires-at";

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
 * Maximum time (ms) to wait for an L1 edge cache (CF Cache API) read before
 * giving up and treating it as a miss. The Cache API is normally sub-millisecond
 * per-colo, so a slow `match` signals a degraded colo; we don't want it adding
 * latency to the request. On timeout the lookup is abandoned, a warning is
 * logged, and the read falls through to its normal miss path (L2/KV or render).
 *
 * This is the default; override per store via
 * `CFCacheStoreOptions.edgeLookupTimeoutMs` (<= 0 disables the budget).
 */
export const EDGE_LOOKUP_TIMEOUT_MS = 10;

/**
 * Maximum time (ms) to wait for the BODY of a matched L1 entry to be read
 * (response.json()) before treating the read as a miss.
 *
 * This is separate from {@link EDGE_LOOKUP_TIMEOUT_MS} on purpose. CF's Cache
 * API resolves `match()` with a lazily-streamed body, so a fast `match` can be
 * followed by a multi-second stall while the body bytes are fetched -- the
 * latency tail lives here, after the match budget has already passed. The
 * default bounds that tail aggressively: a healthy per-colo body read (fetch +
 * JSON parse) settles in low single-digit milliseconds, so 20ms clears a
 * healthy read while still failing fast to L2/KV (or render) on a degraded colo
 * instead of pinning the request behind a seconds-long read. Raise it per store
 * if large Flight payloads legitimately need longer.
 *
 * Override per store via `CFCacheStoreOptions.edgeReadTimeoutMs` (<= 0 disables).
 */
export const EDGE_READ_TIMEOUT_MS = 20;

/**
 * Maximum time (ms) to wait for an L2 (KV) read (`kv.get(key, {type:"json"})`)
 * before treating it as a miss. Unlike the L1 budgets, KV is a GLOBAL store: the
 * file header documents ~50ms healthy reads, and a degraded namespace can tail
 * to seconds. KV is the LAST cache tier before a full render, so an unbounded
 * read here pins the whole request behind a degraded global lookup.
 *
 * The default (50ms) is aggressive -- it sits right at the documented healthy
 * read, trading headroom for a tight bound on the tail. A deployment whose
 * healthy KV reads legitimately run slower (large payloads, far-from-colo
 * regions) will false-miss into a render and should raise this: measure the KV
 * read p99 (Workers Analytics) and add margin. It is a degradation guard-rail,
 * not a tuning lever for "slow KV is normal here".
 *
 * Override per store via `CFCacheStoreOptions.kvReadTimeoutMs` (<= 0 disables).
 */
export const KV_READ_TIMEOUT_MS = 50;

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
function remainingCacheControl(headers: Headers, now: number): string {
  const expiresAt = Number(headers.get(CACHE_EXPIRES_AT_HEADER));
  const remainingTtl =
    Number.isFinite(expiresAt) && expiresAt > 0
      ? Math.max(1, Math.floor((expiresAt - now) / 1000))
      : 1;
  return `public, max-age=${remainingTtl}`;
}

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
  /** RSC-encoded handle data (see handle-snapshot.ts encodeHandles) */
  h?: string;
  /** When entry becomes stale (ms epoch) */
  s: number;
  /** When entry hard-expires (ms epoch) */
  e: number;
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
  /** Serialized headers as key-value pairs */
  hd: [string, string][];
  /** When entry becomes stale (ms epoch) */
  s: number;
  /** When entry hard-expires (ms epoch) */
  e: number;
}

/**
 * One L1 read decision, surfaced when `debug` is enabled. Lets an operator
 * confirm on a real deployment (e.g. via `wrangler tail`) that the store's
 * observed inputs match its decision: which tier answered, the entry's status,
 * the stale/revalidating timestamps, the raw CF `Age` header (so its
 * unreliability can be seen next to the explicit revalidating-at stamp), and
 * the measured match/body-read durations (where the latency tail shows up).
 */
export interface CFCacheReadDebugEvent {
  /**
   * Which read method produced this event. Only the JSON read paths (segment
   * `get` and function `getItem`) participate in debug; the document
   * `getResponse` path streams its body and is intentionally out of scope.
   */
  op: "get" | "getItem";
  /** Cache key (without the internal fn:/doc: prefix or version path). */
  key: string;
  /**
   * What the read resolved to:
   * - l1-fresh / l1-stale-revalidate / l1-revalidating-guarded: L1 hit outcomes
   * - match-timeout / body-timeout: the L1 latency budgets fired
   * - body-error: the L1 body read failed fast (corrupt/non-JSON body) -- a miss
   *   that falls through to L2/KV, distinct from a body-timeout
   * - non-200: L1 returned a non-200 (treated as a miss)
   * - l1-miss: no L1 entry
   * - kv-fresh / kv-stale / kv-miss: L2 fallback outcomes
   * - kv-stale-suppressed: a stale L2 hit served WITHOUT revalidation because
   *   the L1 fall-through was degraded (body-timeout / non-200) -- the herd
   *   mitigation, distinct from kv-stale so the suppression is visible
   * - kv-timeout: the L2/KV read budget fired (read abandoned, NOT a genuine
   *   absence -- distinct from kv-miss so a degradation signal is separable)
   * - error: the read threw
   */
  outcome:
    | "l1-fresh"
    | "l1-stale-revalidate"
    | "l1-revalidating-guarded"
    | "match-timeout"
    | "body-timeout"
    | "body-error"
    | "non-200"
    | "l1-miss"
    | "kv-fresh"
    | "kv-stale"
    | "kv-stale-suppressed"
    | "kv-miss"
    | "kv-timeout"
    | "error";
  /** HTTP status of the matched L1 response, when one was returned. */
  status?: number;
  /**
   * Stored cache status header (CACHE_STATUS_HEADER): "HIT" or "REVALIDATING".
   * Distinct from `isRevalidating`, which also factors in stamp recency -- this
   * is the raw stored value, so a REVALIDATING entry whose stamp aged out (so
   * `isRevalidating` is false) is still distinguishable from a plain HIT.
   */
  cacheStatus?: string | null;
  /** Epoch-ms when the entry goes stale (from CACHE_STALE_AT_HEADER). */
  staleAt?: number;
  /** Epoch-ms the entry was marked REVALIDATING (from the explicit stamp). */
  revalidatingAt?: number;
  /** Raw CF `Age` header, for comparison against revalidatingAt (may be null). */
  ageHeader?: string | null;
  isStale?: boolean;
  isRevalidating?: boolean;
  shouldRevalidate?: boolean;
  /** Wall-clock ms spent in cache.match (bounded by edgeLookupTimeoutMs). */
  matchMs?: number;
  /** Wall-clock ms spent reading the body (bounded by edgeReadTimeoutMs). */
  bodyReadMs?: number;
}

/**
 * Debug sink. `true` logs each {@link CFCacheReadDebugEvent} to console; a
 * function receives the events for programmatic capture.
 */
export type CFCacheDebug = boolean | ((event: CFCacheReadDebugEvent) => void);

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
   */
  kv?: KVNamespace;

  /**
   * Cache version string override. When this changes, all cached entries are
   * effectively invalidated (new keys won't match old entries).
   *
   * Defaults to the auto-generated VERSION from the `@rangojs/router:version` virtual module.
   * Only set this if you need a custom versioning strategy.
   */
  version?: string;

  /**
   * Latency budget (ms) for an L1 edge cache (CF Cache API) read. A `match`
   * slower than this is abandoned and treated as a miss, so a degraded colo
   * cannot stall the request; the read then falls through to its normal miss
   * path (L2/KV or render).
   *
   * Defaults to {@link EDGE_LOOKUP_TIMEOUT_MS} (10). Set to 0 (or any value
   * <= 0) to disable the budget and always await `match`.
   */
  edgeLookupTimeoutMs?: number;

  /**
   * Latency budget (ms) for reading the BODY of a matched L1 entry
   * (response.json()). CF streams the cache body lazily, so the multi-second
   * tail can appear after `match` already resolved; this bounds it. On timeout
   * the read is treated as a miss and falls through to L2/KV or render.
   *
   * Separate from {@link edgeLookupTimeoutMs} because a healthy body read
   * (fetch + JSON parse of a potentially large Flight payload) takes a little
   * longer than a `match`. Defaults to {@link EDGE_READ_TIMEOUT_MS} (20), which
   * clears a healthy per-colo read yet fails fast on a degraded one. Set to 0
   * (or any value <= 0) to disable and always await the body.
   */
  edgeReadTimeoutMs?: number;

  /**
   * Latency budget (ms) for an L2 (KV) read. KV is the last cache tier before a
   * full render and is a global store (~50ms healthy, seconds when degraded);
   * this bounds it so a slow namespace cannot pin the request. On timeout the
   * read is treated as a miss (no L1 promote) and falls through to render.
   *
   * Defaults to {@link KV_READ_TIMEOUT_MS} (50) -- aggressive, right at the
   * healthy read, so raise it if your deployment's healthy KV reads run slower
   * (large payloads / far regions); it is a degradation guard-rail, not a
   * tuning lever. Set to 0 (or any value <= 0) to disable and always await KV.
   */
  kvReadTimeoutMs?: number;

  /**
   * Emit a {@link CFCacheReadDebugEvent} per L1 read. `true` logs to console
   * (visible via `wrangler tail`); pass a function to capture events directly.
   * Off by default. Intended for validating cache behavior on a real
   * deployment before relying on it; not for steady-state production.
   */
  debug?: CFCacheDebug;

  /**
   * Custom key generator applied to all cache operations.
   * Receives the full RequestContext (including env) and the default-generated key.
   * Return value becomes the final cache key (unless route overrides with `key` option).
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
  private readonly explicitBaseUrl?: string;
  private readonly waitUntil?: (fn: () => Promise<void>) => void;
  private readonly version?: string;
  private readonly edgeLookupTimeoutMs: number;
  private readonly edgeReadTimeoutMs: number;
  private readonly kvReadTimeoutMs: number;
  private readonly debug?: (event: CFCacheReadDebugEvent) => void;
  private readonly kv?: KVNamespace;

  constructor(options: CFCacheStoreOptions<TEnv>) {
    if (!options.ctx) {
      throw new Error(
        "[CFCacheStore] ExecutionContext (ctx) is required. " +
          "Pass the Cloudflare ExecutionContext from your worker's fetch handler: " +
          "new CFCacheStore({ ctx: env.ctx })",
      );
    }

    this.namespace = options.namespace;
    // Base URL is resolved lazily per cache operation (see resolveBaseUrl).
    // The store is constructed before the per-request context ALS is entered
    // (the cache factory runs ahead of runWithRequestContext in the handler),
    // so deriving the host here would always miss the request and fall back to
    // the internal host. Only the explicit override can be captured eagerly.
    this.explicitBaseUrl = options.baseUrl;
    this.defaults = options.defaults;
    this.version = options.version ?? VERSION;
    // Coalesce only finite numbers to the override; a non-finite value (NaN from
    // `Number(env.UNSET)`, or Infinity) would otherwise sail past `?? DEFAULT`
    // (which only replaces null/undefined) into setTimeout, where NaN/Infinity
    // are spec-coerced to ~1ms and silently turn the budget into a near-100%
    // false-miss on that tier. A genuine finite 0 or negative still passes
    // through and disables the budget per the documented `<= 0` contract.
    const finiteBudget = (
      value: number | undefined,
      fallback: number,
    ): number =>
      typeof value === "number" && Number.isFinite(value) ? value : fallback;
    this.edgeLookupTimeoutMs = finiteBudget(
      options.edgeLookupTimeoutMs,
      EDGE_LOOKUP_TIMEOUT_MS,
    );
    this.edgeReadTimeoutMs = finiteBudget(
      options.edgeReadTimeoutMs,
      EDGE_READ_TIMEOUT_MS,
    );
    this.kvReadTimeoutMs = finiteBudget(
      options.kvReadTimeoutMs,
      KV_READ_TIMEOUT_MS,
    );
    this.debug =
      options.debug === true
        ? (event) =>
            console.log(`[CFCacheStore:debug] ${JSON.stringify(event)}`)
        : typeof options.debug === "function"
          ? options.debug
          : undefined;
    this.keyGenerator = options.keyGenerator;
    this.waitUntil = (fn) => options.ctx.waitUntil(fn());
    this.kv = options.kv;
  }

  /**
   * Emit a debug event if `debug` is enabled. Swallows sink errors so a faulty
   * debug callback can never break a cache read.
   * @internal
   */
  private emitDebug(event: CFCacheReadDebugEvent): void {
    if (!this.debug) return;
    try {
      this.debug(event);
    } catch {
      // A broken debug sink must not affect the request.
    }
  }

  /**
   * Resolve the cache-key base URL for the current cache operation.
   * Prefers an explicit `baseUrl` option; otherwise derives it from the live
   * request. Called per operation (from keyToRequest), which runs inside the
   * request-context ALS, so deriveBaseUrl sees the request and can use the
   * production host instead of the internal fallback.
   * @internal
   */
  private resolveBaseUrl(): string {
    return this.explicitBaseUrl ?? this.deriveBaseUrl();
  }

  /**
   * Derive base URL from request hostname via requestContext.
   * Uses internal fallback for dev/preview environments and untrusted hostnames.
   * Must run inside the request context (invoked lazily via resolveBaseUrl).
   * @internal
   */
  private deriveBaseUrl(): string {
    const fallback = "https://rsc-dummy-host-1.com/";

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

  /**
   * Race an async cache read against a latency budget. Shared by all three read
   * tiers (L1 match, L1 body, L2/KV) so the timeout policy lives in one place:
   * on timeout it returns `{ value: undefined, timedOut: true }` and logs
   * `${label} exceeded ${budgetMs}ms; treating as miss`; the abandoned read is
   * left to settle in the background (late rejection swallowed) rather than
   * aborted, since the underlying CF primitives expose no cancellation. A budget
   * <= 0 disables the bound and awaits the read directly. `read` is a thunk so
   * the disabled path and the raced path start the read identically.
   * @internal
   */
  private async readWithTimeout<T>(
    read: () => Promise<T>,
    budgetMs: number,
    label: string,
  ): Promise<{ value: T | undefined; timedOut: boolean }> {
    if (budgetMs <= 0) return { value: await read(), timedOut: false };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), budgetMs);
    });
    try {
      const readPromise = read();
      // The losing branch keeps running; ensure a late rejection can't surface
      // as an unhandled rejection once we've stopped awaiting it.
      readPromise.catch(() => {});
      const result = await Promise.race([
        readPromise.then((value) => ({ timedOut: false as const, value })),
        timeout,
      ]);
      if (result.timedOut) {
        console.warn(
          `[CFCacheStore] ${label} exceeded ${budgetMs}ms; treating as miss`,
        );
        return { value: undefined, timedOut: true };
      }
      return { value: result.value, timedOut: false };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Read from the L1 edge cache under the edgeLookupTimeoutMs budget. A `match`
   * slower than the budget is abandoned and reported as a miss
   * (`{ response: undefined, timedOut: true }`) so a degraded colo cannot stall
   * the request; callers fall through to their normal miss path (L2/KV or
   * render). The `timedOut` flag lets callers distinguish an abandoned slow
   * match from a genuine miss for debug reporting.
   * @internal
   */
  private async matchWithTimeout(
    cache: Cache,
    request: Request,
  ): Promise<{ response: Response | undefined; timedOut: boolean }> {
    const { value, timedOut } = await this.readWithTimeout(
      // A fast match rejection is caught at the thunk and reported as a miss
      // (response undefined), so the caller falls through to L2/KV rather than
      // escaping to the outer catch -- symmetric with the body-read thunk.
      () => cache.match(request).catch(() => undefined),
      this.edgeLookupTimeoutMs,
      "edge cache lookup",
    );
    return { response: value, timedOut };
  }

  /**
   * Read and JSON-parse a matched L1 Response's body under the edgeReadTimeoutMs
   * budget. CF resolves `match()` with a lazily-streamed body, so the latency
   * tail surfaces here -- after matchWithTimeout has already passed -- not in the
   * match itself. On timeout `undefined` is returned so the caller falls through
   * to L2/KV or render.
   * @internal
   */
  private async readJsonWithTimeout<T>(
    response: Response,
  ): Promise<{ value: T | undefined; errored: boolean }> {
    // A FAST json() rejection (a corrupt body, or a foreign 200 non-JSON
    // response that collided on this key) is caught at the thunk and turned into
    // a miss, so the caller falls through to L2/KV exactly like a body-timeout
    // -- instead of escaping to get()/getItem()'s outer catch, which returns
    // null WITHOUT ever consulting KV. The catch lives here, not in
    // readWithTimeout, so the L2/KV tier keeps propagating a genuine kv.get
    // rejection to its own error sink. The `errored` flag lets the caller emit a
    // distinct "body-error" debug outcome rather than masquerading as a timeout.
    // On a TIMEOUT the json() promise is still pending, so the catch has not
    // fired: errored stays false and the outcome is correctly a body-timeout. A
    // late rejection after the timeout only mutates the closure flag, which the
    // already-returned object no longer reads.
    let errored = false;
    const { value } = await this.readWithTimeout<T | undefined>(
      () =>
        (response.json() as Promise<T>).catch(() => {
          errored = true;
          return undefined;
        }),
      this.edgeReadTimeoutMs,
      "edge cache body read",
    );
    return { value, errored };
  }

  /**
   * Re-put a stale L1 entry marked REVALIDATING, so concurrent requests serve it
   * without each triggering a revalidation. Shared by get()/getItem().
   *
   * The write is NON-BLOCKING (waitUntil) and best-effort by design:
   * - It runs in waitUntil, so it never adds the put latency to the served stale
   *   read and a put failure can never turn that good read into a miss. The put
   *   is still initiated synchronously (this.waitUntil invokes its callback
   *   immediately), so concurrent readers see the marker land at the same time an
   *   awaited write would -- awaiting only blocks the current request.
   * - The background revalidation's fresh set() is gated behind a full re-render,
   *   so it lands well after this put; a stale-clobbers-fresh race would require
   *   this single put to be slower than that entire render+set, and self-heals
   *   within MAX_REVALIDATION_INTERVAL.
   *
   * Cache-Control is recomputed to the REMAINING ttl from the stored hard-expiry
   * deadline (see remainingCacheControl), not copied from the original
   * full-window header -- copying it would restart CF retention on every re-arm
   * and pin a perpetually-failing entry past hard-expiry. A legacy/tampered entry
   * without a valid deadline floors to max-age=1 and self-heals via KV.
   * @internal
   */
  private markRevalidating(
    cache: Cache,
    request: Request,
    sourceHeaders: Headers,
    status: number,
    body: string,
  ): void {
    const reputNow = Date.now();
    const headers = new Headers(sourceHeaders);
    headers.set(CACHE_STATUS_HEADER, "REVALIDATING");
    headers.set(CACHE_REVALIDATING_AT_HEADER, String(reputNow));
    headers.set("Cache-Control", remainingCacheControl(headers, reputNow));
    const markerResponse = new Response(body, { status, headers });
    const write = async (): Promise<void> => {
      try {
        await cache.put(request, markerResponse);
      } catch {
        // Best-effort: a failed marker write must not affect the served read;
        // the entry simply re-arms on the next stale read.
      }
    };
    if (this.waitUntil) this.waitUntil(write);
    else void write();
  }

  // ============================================================================
  // Segment Cache Methods
  // ============================================================================

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
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(key);
      const matchStart = Date.now();
      const { response, timedOut } = await this.matchWithTimeout(
        cache,
        request,
      );
      const matchMs = Date.now() - matchStart;

      if (!response) {
        // Genuine L1 miss, or matchWithTimeout abandoned a slow match (timedOut).
        if (this.debug)
          this.emitDebug({
            op: "get",
            key,
            outcome: timedOut ? "match-timeout" : "l1-miss",
            matchMs,
          });
        return this.kvGetSegment(key);
      }

      // A non-200 entry (a cached error response, or a foreign response that
      // landed on this key) is not valid segment data; treat it as a miss
      // rather than JSON-parsing garbage and serving it as a hit.
      if (response.status !== 200) {
        if (this.debug)
          this.emitDebug({
            op: "get",
            key,
            outcome: "non-200",
            status: response.status,
            matchMs,
          });
        // Degraded fall-through: suppress revalidation so a broken L1 entry hit
        // concurrently serves KV-stale, not a herd. See kvGetSegment.
        return this.kvGetSegment(key, { suppressRevalidate: true });
      }

      // Read status headers
      const status = response.headers.get(CACHE_STATUS_HEADER);
      const staleAt = Number(
        response.headers.get(CACHE_STALE_AT_HEADER) ?? "0",
      );
      const revalidatingAt = Number(
        response.headers.get(CACHE_REVALIDATING_AT_HEADER) ?? "0",
      );

      const now = Date.now();
      const isStale = staleAt > 0 && now > staleAt;
      // Recency comes from our explicit revalidating-at stamp, not CF's `Age`
      // header (see CACHE_REVALIDATING_AT_HEADER). An absent/zero stamp counts
      // as "not recent" so a dropped revalidation re-arms instead of pinning.
      const isRevalidating =
        status === "REVALIDATING" &&
        revalidatingAt > 0 &&
        now - revalidatingAt < MAX_REVALIDATION_INTERVAL * 1000;

      // Single emitter for the post-header L1 outcomes. Undefined (so the event
      // object is never allocated) when debug is off; the informational-only
      // `age` header is read lazily inside for the same reason.
      const debugRead = this.debug
        ? (
            outcome: CFCacheReadDebugEvent["outcome"],
            bodyReadMs: number,
            shouldRevalidate?: boolean,
          ) =>
            this.emitDebug({
              op: "get",
              key,
              outcome,
              status: response.status,
              cacheStatus: status,
              staleAt,
              revalidatingAt,
              ageHeader: response.headers.get("age"),
              isStale,
              isRevalidating,
              shouldRevalidate,
              matchMs,
              bodyReadMs,
            })
        : undefined;

      // Case 1: Fresh or already being revalidated - just return data
      if (!isStale || isRevalidating) {
        const bodyStart = Date.now();
        const { value: data, errored } =
          await this.readJsonWithTimeout<CachedEntryData>(response);
        const bodyReadMs = Date.now() - bodyStart;
        if (data === undefined) {
          debugRead?.(errored ? "body-error" : "body-timeout", bodyReadMs);
          // A body-TIMEOUT is a degraded read of a (likely valid) entry:
          // suppress revalidation so a stalling colo cannot amplify into a herd.
          // A body-ERROR (corrupt/foreign body) is NOT suppressed -- revalidating
          // heals the bad L1 entry by overwriting it with a fresh render.
          return this.kvGetSegment(key, { suppressRevalidate: !errored });
        }
        debugRead?.(
          isRevalidating ? "l1-revalidating-guarded" : "l1-fresh",
          bodyReadMs,
          false,
        );
        return { data, shouldRevalidate: false };
      }

      // Case 2: Stale and needs revalidation.
      // Read the body under the edge-read budget BEFORE writing the REVALIDATING
      // marker. CF can resolve match() fast but stall the body stream; the prior
      // approach teed the stream and awaited cache.put(b1) first, which blocked
      // on that same stalled stream so the read budget could never fire on a
      // stale hit. Reading first bounds the stall and lets us skip marking an
      // entry we could not even read.
      const bodyStart = Date.now();
      const { value: data, errored } =
        await this.readJsonWithTimeout<CachedEntryData>(response);
      const bodyReadMs = Date.now() - bodyStart;
      if (data === undefined) {
        debugRead?.(errored ? "body-error" : "body-timeout", bodyReadMs);
        // Suppress a body-timeout but not a body-error (which heals); see Case 1.
        return this.kvGetSegment(key, { suppressRevalidate: !errored });
      }

      // Mark REVALIDATING so concurrent requests don't all revalidate, then
      // return the stale data. The marker write is non-blocking and best-effort
      // (see markRevalidating) -- it must not add latency to, or fail, the served
      // stale read.
      this.markRevalidating(
        cache,
        request,
        response.headers,
        response.status,
        JSON.stringify(data),
      );

      debugRead?.("l1-stale-revalidate", bodyReadMs, true);
      return { data, shouldRevalidate: true };
    } catch (error) {
      console.error("[CFCacheStore] get failed:", error);
      if (this.debug) this.emitDebug({ op: "get", key, outcome: "error" });
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
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(key);

      // Extended TTL covers SWR window
      const swrWindow = resolveSwrWindow(swr, this.defaults);
      const totalTtl = ttl + swrWindow;
      const staleAt = Date.now() + ttl * 1000;

      const body = JSON.stringify(data);
      const response = new Response(body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${totalTtl}`,
          [CACHE_STALE_AT_HEADER]: String(staleAt),
          // Absolute hard-expiry deadline so a stale-path re-put can recompute a
          // shrinking max-age instead of restarting retention (see
          // remainingCacheControl / CACHE_EXPIRES_AT_HEADER).
          [CACHE_EXPIRES_AT_HEADER]: String(staleAt + swrWindow * 1000),
          [CACHE_STATUS_HEADER]: "HIT",
        },
      });

      const putPromise = cache.put(request, response);

      if (this.waitUntil) {
        // Non-blocking write
        this.waitUntil(async () => {
          await putPromise;
        });
      } else {
        // Blocking fallback
        await putPromise;
      }

      // L2: persist to KV
      this.kvSetSegment(key, data, staleAt, totalTtl, swrWindow);
    } catch (error) {
      console.error("[CFCacheStore] set failed:", error);
    }
  }

  /**
   * Delete a cached entry from L1 and L2.
   */
  async delete(key: string): Promise<boolean> {
    try {
      const cache = await this.getCache();
      const result = await cache.delete(this.keyToRequest(key));

      // L2: delete from KV
      if (this.kv && this.waitUntil) {
        const kvKey = this.toKVKey(key);
        this.waitUntil(async () => {
          try {
            await this.kv!.delete(kvKey);
          } catch {
            // KV delete failures are non-critical
          }
        });
      }

      return result;
    } catch (error) {
      console.error("[CFCacheStore] delete failed:", error);
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
      // The document path is outside the debug surface (op is only get/getItem),
      // so the match-timeout flag is not surfaced as an event here -- though
      // matchWithTimeout still warns on a slow match. A miss or timeout falls
      // through to the KV document path and then render.
      const { response } = await this.matchWithTimeout(cache, request);

      if (!response || response.status !== 200) {
        return this.kvGetResponse(key);
      }

      // Check staleness
      const staleAt = Number(response.headers.get(CACHE_STALE_AT_HEADER) || 0);
      const isStale = staleAt > 0 && Date.now() > staleAt;

      return {
        response: this.toClientResponse(response),
        shouldRevalidate: isStale,
      };
    } catch (error) {
      console.error("[CFCacheStore] getResponse failed:", error);
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
  ): Promise<void> {
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(`doc:${key}`);

      // Extended TTL covers SWR window
      const swrWindow = resolveSwrWindow(swr, this.defaults);
      const totalTtl = ttl + swrWindow;
      const staleAt = Date.now() + ttl * 1000;

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

      const toCache = new Response(l1Body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });

      const putPromise = cache.put(request, toCache);

      if (this.waitUntil) {
        // Non-blocking write
        this.waitUntil(async () => {
          await putPromise;
        });
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

        this.waitUntil(async () => {
          try {
            const envelope: KVResponseEnvelope = {
              b: bodyBase64,
              st: response.status,
              stx: response.statusText,
              hd: headersArray,
              s: staleAt,
              e: staleAt + swrWindow * 1000,
            };
            await this.kv!.put(kvKey, JSON.stringify(envelope), {
              expirationTtl: totalTtl,
            });
          } catch (error) {
            console.error("[CFCacheStore] KV putResponse failed:", error);
          }
        });
      }
    } catch (error) {
      console.error("[CFCacheStore] putResponse failed:", error);
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
      const matchStart = Date.now();
      const { response, timedOut } = await this.matchWithTimeout(
        cache,
        request,
      );
      const matchMs = Date.now() - matchStart;

      if (!response) {
        if (this.debug)
          this.emitDebug({
            op: "getItem",
            key,
            outcome: timedOut ? "match-timeout" : "l1-miss",
            matchMs,
          });
        return this.kvGetItem(key);
      }

      // Non-200 entry is not a valid cached function result; treat as a miss.
      if (response.status !== 200) {
        if (this.debug)
          this.emitDebug({
            op: "getItem",
            key,
            outcome: "non-200",
            status: response.status,
            matchMs,
          });
        // Degraded fall-through: suppress revalidation so a broken L1 entry hit
        // concurrently serves KV-stale instead of spawning a herd (see get()).
        return this.kvGetItem(key, { suppressRevalidate: true });
      }

      const staleAt = Number(
        response.headers.get(CACHE_STALE_AT_HEADER) ?? "0",
      );
      const status = response.headers.get(CACHE_STATUS_HEADER);
      const revalidatingAt = Number(
        response.headers.get(CACHE_REVALIDATING_AT_HEADER) ?? "0",
      );

      const now = Date.now();
      const isStale = staleAt > 0 && now > staleAt;
      // Recency from our explicit stamp, not CF's `Age` header (see get()).
      const isRevalidating =
        status === "REVALIDATING" &&
        revalidatingAt > 0 &&
        now - revalidatingAt < MAX_REVALIDATION_INTERVAL * 1000;

      // Single emitter for the post-header L1 outcomes (see get()). Undefined
      // when debug is off, so the event object is never allocated on the hot
      // path; the informational-only `age` header is read lazily inside.
      const debugRead = this.debug
        ? (
            outcome: CFCacheReadDebugEvent["outcome"],
            bodyReadMs: number,
            shouldRevalidate?: boolean,
          ) =>
            this.emitDebug({
              op: "getItem",
              key,
              outcome,
              status: response.status,
              cacheStatus: status,
              staleAt,
              revalidatingAt,
              ageHeader: response.headers.get("age"),
              isStale,
              isRevalidating,
              shouldRevalidate,
              matchMs,
              bodyReadMs,
            })
        : undefined;

      const bodyStart = Date.now();
      const { value: data, errored } = await this.readJsonWithTimeout<{
        value: string;
        handles?: string;
      }>(response);
      const bodyReadMs = Date.now() - bodyStart;
      if (data === undefined) {
        debugRead?.(errored ? "body-error" : "body-timeout", bodyReadMs);
        // Suppress a body-timeout but not a body-error (which heals); see get().
        return this.kvGetItem(key, { suppressRevalidate: !errored });
      }

      if (!isStale || isRevalidating) {
        debugRead?.(
          isRevalidating ? "l1-revalidating-guarded" : "l1-fresh",
          bodyReadMs,
          false,
        );
        return {
          value: data.value,
          handles: data.handles,
          shouldRevalidate: false,
        };
      }

      // Stale and needs revalidation -- mark REVALIDATING (non-blocking,
      // best-effort, remaining-ttl) and return the stale value. See get() /
      // markRevalidating for the full rationale.
      this.markRevalidating(
        cache,
        request,
        response.headers,
        200,
        JSON.stringify(data),
      );

      debugRead?.("l1-stale-revalidate", bodyReadMs, true);
      return {
        value: data.value,
        handles: data.handles,
        shouldRevalidate: true,
      };
    } catch (error) {
      console.error("[CFCacheStore] getItem failed:", error);
      if (this.debug) this.emitDebug({ op: "getItem", key, outcome: "error" });
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

      const body = JSON.stringify({ value, handles: options?.handles });
      const response = new Response(body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${totalTtl}`,
          [CACHE_STALE_AT_HEADER]: String(staleAt),
          // Absolute hard-expiry deadline; see set() / remainingCacheControl.
          [CACHE_EXPIRES_AT_HEADER]: String(staleAt + swrWindow * 1000),
          [CACHE_STATUS_HEADER]: "HIT",
        },
      });

      const putPromise = cache.put(request, response);

      if (this.waitUntil) {
        this.waitUntil(async () => {
          await putPromise;
        });
      } else {
        await putPromise;
      }

      // L2: persist to KV (KV requires expirationTtl >= 60s)
      if (this.kv && this.waitUntil && totalTtl >= 60) {
        const kvKey = this.toKVKey(`fn:${key}`);
        this.waitUntil(async () => {
          try {
            const envelope: KVItemEnvelope = {
              v: value,
              h: options?.handles,
              s: staleAt,
              e: staleAt + swrWindow * 1000,
            };
            await this.kv!.put(kvKey, JSON.stringify(envelope), {
              expirationTtl: totalTtl,
            });
          } catch (error) {
            console.error("[CFCacheStore] KV setItem failed:", error);
          }
        });
      }
    } catch (error) {
      console.error("[CFCacheStore] setItem failed:", error);
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
    return new Request(`${this.resolveBaseUrl()}${versionPath}${encodedKey}`, {
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

  // ============================================================================
  // KV L2 Helpers
  // ============================================================================

  /**
   * KV fallback for segment cache reads.
   * Returns null if KV is not configured, entry is missing, or expired.
   * Promotes hits to L1 via waitUntil.
   * @internal
   */
  private async kvGetSegment(
    key: string,
    opts?: { suppressRevalidate?: boolean },
  ): Promise<CacheGetResult | null> {
    if (!this.kv) return null;

    try {
      const kvKey = this.toKVKey(key);
      const { value: raw, timedOut } = await this.readWithTimeout(
        () => this.kv!.get(kvKey, { type: "json" }),
        this.kvReadTimeoutMs,
        "KV read",
      );
      if (timedOut) {
        // Abandoned slow KV read: no envelope, so no promote-to-L1. Distinct
        // from a genuine kv-miss so the degradation is visible on wrangler tail.
        if (this.debug)
          this.emitDebug({ op: "get", key, outcome: "kv-timeout" });
        return null;
      }
      if (!raw) {
        if (this.debug) this.emitDebug({ op: "get", key, outcome: "kv-miss" });
        return null;
      }

      const envelope = raw as KVSegmentEnvelope;
      const now = Date.now();

      // Hard-expired — treat as miss
      if (now > envelope.e) {
        if (this.debug) this.emitDebug({ op: "get", key, outcome: "kv-miss" });
        return null;
      }

      // When this is a degraded L1 fall-through (body-timeout / non-200), the
      // caller asks us to suppress revalidation: KV has no REVALIDATING herd
      // guard, so N concurrent degraded reads would otherwise each spawn a
      // render exactly when the colo is already struggling. We still serve the
      // stale data and still promote to L1; only the revalidation is withheld.
      const stale = now > envelope.s;
      const shouldRevalidate = stale && !opts?.suppressRevalidate;

      // Promote to L1 in background
      this.promoteSegmentToL1(key, envelope);

      if (this.debug)
        this.emitDebug({
          op: "get",
          key,
          outcome: !stale
            ? "kv-fresh"
            : opts?.suppressRevalidate
              ? "kv-stale-suppressed"
              : "kv-stale",
          shouldRevalidate,
        });
      return { data: envelope.d, shouldRevalidate };
    } catch (error) {
      console.error("[CFCacheStore] KV get failed:", error);
      if (this.debug) this.emitDebug({ op: "get", key, outcome: "error" });
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

    this.waitUntil(async () => {
      try {
        const envelope: KVSegmentEnvelope = {
          d: data,
          s: staleAt,
          e: expiresAt,
        };
        await this.kv!.put(kvKey, JSON.stringify(envelope), {
          expirationTtl: totalTtl,
        });
      } catch (error) {
        console.error("[CFCacheStore] KV set failed:", error);
      }
    });
  }

  /**
   * Promote segment data from KV to L1 Cache API.
   * @internal
   */
  private promoteSegmentToL1(key: string, envelope: KVSegmentEnvelope): void {
    if (!this.waitUntil) return;

    this.waitUntil(async () => {
      try {
        const now = Date.now();
        const remainingTtl = Math.max(1, Math.floor((envelope.e - now) / 1000));
        const cache = await this.getCache();
        const request = this.keyToRequest(key);

        const response = new Response(JSON.stringify(envelope.d), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `public, max-age=${remainingTtl}`,
            [CACHE_STALE_AT_HEADER]: String(envelope.s),
            // Carry the hard-expiry deadline so a promoted entry that later goes
            // stale re-puts with the correct remaining ttl (see set()).
            [CACHE_EXPIRES_AT_HEADER]: String(envelope.e),
            [CACHE_STATUS_HEADER]: "HIT",
          },
        });

        await cache.put(request, response);
      } catch (error) {
        console.error("[CFCacheStore] L1 promote failed:", error);
      }
    });
  }

  /**
   * KV fallback for function cache reads.
   * @internal
   */
  private async kvGetItem(
    key: string,
    opts?: { suppressRevalidate?: boolean },
  ): Promise<CacheItemResult | null> {
    if (!this.kv) return null;

    try {
      const kvKey = this.toKVKey(`fn:${key}`);
      const { value: raw, timedOut } = await this.readWithTimeout(
        () => this.kv!.get(kvKey, { type: "json" }),
        this.kvReadTimeoutMs,
        "KV read",
      );
      if (timedOut) {
        if (this.debug)
          this.emitDebug({ op: "getItem", key, outcome: "kv-timeout" });
        return null;
      }
      if (!raw) {
        if (this.debug)
          this.emitDebug({ op: "getItem", key, outcome: "kv-miss" });
        return null;
      }

      const envelope = raw as KVItemEnvelope;
      const now = Date.now();

      if (now > envelope.e) {
        if (this.debug)
          this.emitDebug({ op: "getItem", key, outcome: "kv-miss" });
        return null;
      }

      // Degraded fall-through suppresses revalidation (no KV herd guard); see
      // kvGetSegment. Still serves stale and still promotes.
      const stale = now > envelope.s;
      const shouldRevalidate = stale && !opts?.suppressRevalidate;

      // Promote to L1
      this.promoteItemToL1(key, envelope);

      if (this.debug)
        this.emitDebug({
          op: "getItem",
          key,
          outcome: !stale
            ? "kv-fresh"
            : opts?.suppressRevalidate
              ? "kv-stale-suppressed"
              : "kv-stale",
          shouldRevalidate,
        });
      return {
        value: envelope.v,
        handles: envelope.h,
        shouldRevalidate,
      };
    } catch (error) {
      console.error("[CFCacheStore] KV getItem failed:", error);
      if (this.debug) this.emitDebug({ op: "getItem", key, outcome: "error" });
      return null;
    }
  }

  /**
   * Promote function cache data from KV to L1.
   * @internal
   */
  private promoteItemToL1(key: string, envelope: KVItemEnvelope): void {
    if (!this.waitUntil) return;

    this.waitUntil(async () => {
      try {
        const now = Date.now();
        const remainingTtl = Math.max(1, Math.floor((envelope.e - now) / 1000));
        const cache = await this.getCache();
        const request = this.keyToRequest(`fn:${key}`);

        const body = JSON.stringify({ value: envelope.v, handles: envelope.h });
        const response = new Response(body, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `public, max-age=${remainingTtl}`,
            [CACHE_STALE_AT_HEADER]: String(envelope.s),
            // Carry the hard-expiry deadline; see promoteSegmentToL1 / set().
            [CACHE_EXPIRES_AT_HEADER]: String(envelope.e),
            [CACHE_STATUS_HEADER]: "HIT",
          },
        });

        await cache.put(request, response);
      } catch (error) {
        console.error("[CFCacheStore] L1 item promote failed:", error);
      }
    });
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
      const { value: raw, timedOut } = await this.readWithTimeout(
        () => this.kv!.get(kvKey, { type: "json" }),
        this.kvReadTimeoutMs,
        "KV read",
      );
      // The document path is debug-silent (op is only get/getItem): a KV-read
      // timeout here is bounded for resilience parity but emits no kv-timeout
      // event, so its absence from the debug stream is expected.
      if (timedOut || !raw) return null;

      const envelope = raw as KVResponseEnvelope;
      const now = Date.now();

      if (now > envelope.e) return null;

      const shouldRevalidate = now > envelope.s;

      // Reconstruct Response (decode base64 → binary)
      const headers = new Headers(envelope.hd);
      const bodyBuffer = base64ToBuffer(envelope.b);
      const response = new Response(bodyBuffer, {
        status: envelope.st,
        statusText: envelope.stx,
        headers,
      });

      // Promote to L1
      this.promoteResponseToL1(key, envelope);

      return { response, shouldRevalidate };
    } catch (error) {
      console.error("[CFCacheStore] KV getResponse failed:", error);
      return null;
    }
  }

  /**
   * Promote document cache data from KV to L1.
   * @internal
   */
  private promoteResponseToL1(key: string, envelope: KVResponseEnvelope): void {
    if (!this.waitUntil) return;

    this.waitUntil(async () => {
      try {
        const now = Date.now();
        const remainingTtl = Math.max(1, Math.floor((envelope.e - now) / 1000));
        const cache = await this.getCache();
        const request = this.keyToRequest(`doc:${key}`);

        const headers = new Headers(envelope.hd);
        const originalCacheControl = headers.get("Cache-Control");
        if (originalCacheControl !== null) {
          headers.set(CACHE_ORIG_CC_HEADER, originalCacheControl);
        }
        headers.set("Cache-Control", `public, max-age=${remainingTtl}`);
        headers.set(CACHE_STALE_AT_HEADER, String(envelope.s));

        const bodyBuffer = base64ToBuffer(envelope.b);
        const response = new Response(bodyBuffer, {
          status: envelope.st,
          statusText: envelope.stx,
          headers,
        });

        await cache.put(request, response);
      } catch (error) {
        console.error("[CFCacheStore] L1 response promote failed:", error);
      }
    });
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
