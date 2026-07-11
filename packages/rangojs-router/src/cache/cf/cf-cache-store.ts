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
  ShellCacheEntry,
} from "../types.js";
import {
  _getRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import { VERSION } from "@rangojs/router:version";
import {
  isPerClientSignalHeader,
  stripPerClientSignals,
} from "../../browser/cookie-name.js";
import {
  resolveTtl,
  resolveSwrWindow,
  DEFAULT_FUNCTION_TTL,
} from "../cache-policy.js";
import { reportCacheError, reportingAsync } from "../cache-error.js";
import type { CacheErrorCategory } from "../cache-error.js";
import { bufferToBase64, base64ToBuffer } from "./cf-base64.js";
import {
  KV_MAX_KEY_BYTES,
  KV_MIN_EXPIRATION_TTL,
  kvKeyByteLength,
  remainingCacheControl,
} from "./cf-kv-utils.js";
import {
  TAG_MARKER_CACHE_PREFIX,
  TAG_MARKER_ABSENT,
  getTagMarkerMemo,
  getTagMarkerInflight,
} from "./cf-tag-marker-memo.js";
import { createCloudflareZonePurge } from "./cf-zone-purge.js";

// ============================================================================
// Constants
// ============================================================================
//
// Header names, KV prefixes, and timeout/interval defaults live in
// cf-cache-constants.ts so collaborator modules can share them without a
// circular import back to this class. They are re-exported below so existing
// import paths (`../cf-cache-store`, `./cf-cache-store.js`) still resolve.
import {
  CACHE_STALE_AT_HEADER,
  CACHE_STATUS_HEADER,
  CACHE_TAGS_HEADER,
  CACHE_TAGGED_AT_HEADER,
  TAG_MARKER_PREFIX,
  CACHE_REVALIDATING_AT_HEADER,
  CACHE_EXPIRES_AT_HEADER,
  CACHE_ORIG_CC_HEADER,
  MAX_REVALIDATION_INTERVAL,
  EDGE_LOOKUP_TIMEOUT_MS,
  EDGE_READ_TIMEOUT_MS,
  KV_READ_TIMEOUT_MS,
} from "./cf-cache-constants.js";

// Re-export the public constants so consumers/tests importing them from
// cf-cache-store keep working after the move.
export {
  CACHE_STALE_AT_HEADER,
  CACHE_STATUS_HEADER,
  CACHE_TAGS_HEADER,
  CACHE_TAGGED_AT_HEADER,
  TAG_MARKER_PREFIX,
  CACHE_REVALIDATING_AT_HEADER,
  MAX_REVALIDATION_INTERVAL,
  EDGE_LOOKUP_TIMEOUT_MS,
  EDGE_READ_TIMEOUT_MS,
  KV_READ_TIMEOUT_MS,
};

// The tag-marker prefix/sentinel and per-request memo helpers (with their
// module-singleton WeakMaps) live in cf-tag-marker-memo.ts; imported above.

/**
 * Per-request memo of the derived cache-key base URL.
 *
 * deriveBaseUrl() is a pure function of the live request URL, but keyToRequest
 * calls it on EVERY cache operation (each segment/item get/set/delete, each
 * KV->L1 promote, each tag-marker read), so a page composed of many cached
 * entries re-parses the same request.url and re-runs the host validation tens
 * of times. Keying by the request-context object collapses that to one derive
 * per request. Keyed by ctx alone (not by store) because the derived value
 * depends only on the request URL, not on which store asked.
 */
const derivedBaseUrlMemo = new WeakMap<object, string>();

// Pure KV helpers (key byte-length limits, expirationTtl floor, stale-path
// Cache-Control recompute) live in cf-kv-utils.ts; imported above.

/**
 * Stores (by namespace) already warned about tag machinery configured without a
 * KV namespace, so the warning fires once per process rather than per request
 * (CFCacheStore is constructed per request).
 */
const warnedNoKvReadInvalidation = new Set<string>();

/**
 * Stores (by namespace) already warned about a tagInvalidationTtl below KV's
 * expirationTtl floor, so the floor warning fires once per process rather than
 * once per request (CFCacheStore is constructed per request).
 */
const warnedTagInvalidationTtlFloor = new Set<string>();

/**
 * Stores (by namespace) already warned about the shell family being inert
 * (getShell/putShell no-op without a KV namespace), so a ppr route hitting the
 * silent fail-open warns once per isolate instead of on every request.
 */
const warnedShellFamilyInert = new Set<string>();

/**
 * Stores (by namespace) already warned that tag invalidation is writing KV
 * markers with no expiry (tagInvalidationTtl unset), so the unbounded-growth
 * warning fires once per process rather than once per invalidateTags call
 * (CFCacheStore is constructed per request; invalidateTags runs per marker
 * batch). Distinct from the floor warning: that one only fires for a positive
 * below-floor value, never for the unset (no-expiry) default that this bounds.
 */
const warnedNoTagInvalidationTtl = new Set<string>();

/**
 * Stores (by namespace) already warned that an entry's tag set produced a
 * Cache-Tag header over Cloudflare's aggregate limit, so the header was
 * omitted (the entry stays cacheable and marker-invalidatable; it just cannot
 * be evicted per-tag by a purge). Once per process, not per write.
 */
const warnedCacheTagHeaderOverflow = new Set<string>();

/**
 * Stores (by namespace) already warned that an over-limit tag set made an
 * entry UNCACHEABLE in KV-less purge mode: with no Cache-Tag tokens a purge
 * cannot evict it, and with no KV there is no marker fallback either, so
 * caching it would serve stale until TTL while updateTag() reports success.
 * Once per process, not per write.
 */
const warnedCacheTagOverflowUncacheable = new Set<string>();

/**
 * Max length of one emitted `rg:*` Cache-Tag token. Cloudflare caps a purge
 * API tag value at 1,024 characters and the aggregate Cache-Tag header at
 * 16 KB; an application tag is unbounded, so an over-long token is collapsed
 * to a deterministic hash (see boundedTagToken) instead of being allowed to
 * fail the whole L1 write. 256 keeps headers compact while leaving room for
 * long-but-reasonable tag names under any namespace.
 */
const CACHE_TAG_TOKEN_MAX = 256;

/**
 * Cloudflare's documented aggregate Cache-Tag header limit (16 KB). A tagged
 * entry whose tokens would exceed it gets NO Cache-Tag header (plus a
 * once-per-namespace warning) rather than a failed cache write; the read path
 * then falls back to the marker check for that entry (see isL1Invalidated).
 */
const CACHE_TAG_HEADER_MAX_BYTES = 16 * 1024;

/**
 * FNV-1a 64-bit hash of a tag value, hex-encoded. Used to bound over-long
 * Cache-Tag tokens: deterministic (write-time token === purge-time token) and
 * collision-safe in the failure direction — a collision over-purges (an extra
 * eviction, healed by the next render), never serves stale.
 * @internal
 */
function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

// ============================================================================
// Types
// ============================================================================
//
// The shared public types (KVNamespace, CFCacheReadDebugEvent, CFCacheDebug,
// CFCacheStoreOptions) live in cf-cache-types.ts; imported and re-exported below
// so existing import paths still resolve. The private KV envelope interfaces
// stay here with the methods that read/write them.
import type {
  KVNamespace,
  CFCacheReadDebugEvent,
  CFCacheDebug,
  CFCacheStoreOptions,
} from "./cf-cache-types.js";
export type {
  KVNamespace,
  CFCacheReadDebugEvent,
  CFCacheDebug,
  CFCacheStoreOptions,
};

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
  /** Cache tags (for distributed tag invalidation) */
  t?: string[];
  /** Timestamp when tags were attached (ms epoch) */
  ta?: number;
}

/**
 * KV envelope for PPR shell cache entries.
 * @internal
 */
interface KVShellEnvelope {
  /** base64-encoded prelude bytes */
  p: string;
  /** postponed state JSON, or null (DATA variant — no holes) */
  po: string | null;
  /** React.version captured at prerender time */
  rv: string;
  /** Build version captured at prerender time (ShellCacheEntry.buildVersion) */
  bv?: string;
  /** Capture-generation start time (ms epoch), used by tag marker checks. */
  c: number;
  /** When entry becomes stale (ms epoch) */
  s: number;
  /** When entry hard-expires (ms epoch) */
  e: number;
  /** Cache tags (for distributed tag invalidation) */
  t?: string[];
  /** Timestamp when tags were attached (ms epoch) */
  ta?: number;
  /** initialTheme the capture render was built with (resume theme fidelity) */
  i?: string;
  /** Capture data snapshot: recorded cache-store hits/writes for HIT parity */
  sn?: import("../types.js").ShellSnapshotRecord[];
  /**
   * ShellCacheEntry.handlerLiveHoles. Must round-trip: the serve side arms the
   * handler-free fast path on `!entry.handlerLiveHoles`, so dropping the flag
   * here silently fast-pathed handler-live entries after a KV round trip —
   * their holes only a handler re-run can fill.
   */
  lh?: boolean;
  /** ShellCacheEntry.transitionWhen; conditional transitions must re-run. */
  tw?: true;
  /** ShellCacheEntry.navigationOnly; its partial-context prelude is not document-safe. */
  no?: true;
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

// ============================================================================
// CFCacheStore Implementation
// ============================================================================

export class CFCacheStore<TEnv = unknown> implements SegmentCacheStore<TEnv> {
  readonly supportsPassiveShellReads: true = true;
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
  private readonly onRevalidateTag?: (tags: string[]) => Promise<void>;
  private readonly tagPurge?: (cacheTags: string[]) => Promise<void>;
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
    this.onRevalidateTag = options.onRevalidateTag;
    // tagPurge accepts a ready purge function or a credentials object; the
    // object form is normalized through the built-in zone purge client, which
    // validates zoneId/apiToken eagerly so an unset env var fails at
    // construction instead of on the first updateTag().
    this.tagPurge =
      typeof options.tagPurge === "function"
        ? options.tagPurge
        : options.tagPurge
          ? createCloudflareZonePurge(options.tagPurge)
          : undefined;
    // tagInvalidationTtl feeds KV's expirationTtl, which CF rejects below
    // KV_MIN_EXPIRATION_TTL (60s) -- a too-small finite value would make EVERY
    // marker write throw and break ALL invalidation. Floor it (and warn once);
    // a non-finite/non-positive value falls back to the no-expiry default
    // (markers persist) rather than silently sailing a NaN into expirationTtl.
    this.tagInvalidationTtl = this.sanitizeTagInvalidationTtl(
      options.tagInvalidationTtl,
    );
    // tagCacheTtl gates the L1 marker cache via `> 0`. A non-finite value (NaN
    // from `Number(env.UNSET)`) is not null/undefined, so `?? 0` would let it
    // through and silently disable the cache while reading as "configured".
    // finiteBudget coerces non-finite/null/undefined to 0; the `> 0` guard then
    // collapses a finite non-positive value to the documented 0 = disabled.
    const tagCacheTtl = finiteBudget(options.tagCacheTtl, 0);
    this.tagCacheTtl = tagCacheTtl > 0 ? tagCacheTtl : 0;

    // Read-side tag invalidation requires KV: isGloballyInvalidated() compares an
    // entry's taggedAt against the per-tag KV marker and short-circuits to "not
    // invalidated" when no KV namespace is configured. A consumer who wires the
    // tag machinery (tagCacheTtl for L1 markers, or onRevalidateTag for CDN purge)
    // but omits kv gets only the purge fired - marker writes are skipped without
    // kv - yet every tagged read still serves stale data with no other signal.
    // Surface that misconfiguration. Exception: with tagPurge configured (purge
    // mode) L1 eviction is the purge itself, so a KV-less store is a supported
    // L1-only configuration, not a silent no-op.
    if (
      !this.kv &&
      !this.tagPurge &&
      (this.tagCacheTtl > 0 || this.onRevalidateTag)
    ) {
      this.warnOncePerNamespace(
        warnedNoKvReadInvalidation,
        `[CFCacheStore] tagCacheTtl/onRevalidateTag is configured without a KV ` +
          `namespace, so tag invalidation has NO read-side effect: tagged reads ` +
          `are never treated as invalidated and serve stale data. Configure ` +
          `{ kv } for distributed tag invalidation.`,
      );
    }
  }

  /**
   * Warn about a namespace-scoped misconfiguration once per namespace per
   * isolate. `seen` is the module-level Set for that message family -- Sets
   * are module-level (not instance fields) so re-constructed stores in the
   * same isolate don't re-warn.
   * @internal
   */
  private warnOncePerNamespace(seen: Set<string>, message: string): void {
    const id = this.namespace ?? "default";
    if (seen.has(id)) return;
    seen.add(id);
    console.warn(message);
  }

  /**
   * Validate a consumer-supplied tagInvalidationTtl against CF KV's expirationTtl
   * floor. A finite value below KV_MIN_EXPIRATION_TTL is raised to it (with a
   * one-time warning) so invalidation keeps working instead of every marker
   * write throwing; a non-finite or non-positive value returns undefined (the
   * no-expiry default). The warning still notes the sizing rule: the TTL must
   * exceed the largest entry TTL+SWR or invalidated entries can resurrect.
   * @internal
   */
  private sanitizeTagInvalidationTtl(
    value: number | undefined,
  ): number | undefined {
    if (value == null) return undefined;
    if (!Number.isFinite(value) || value <= 0) return undefined;
    if (value < KV_MIN_EXPIRATION_TTL) {
      this.warnOncePerNamespace(
        warnedTagInvalidationTtlFloor,
        `[CFCacheStore] tagInvalidationTtl ${value} is below Cloudflare KV's ` +
          `${KV_MIN_EXPIRATION_TTL}s expirationTtl floor; raising to ` +
          `${KV_MIN_EXPIRATION_TTL}. It must still exceed your largest entry ` +
          `TTL+SWR or invalidated entries can resurrect when the marker expires.`,
      );
      return KV_MIN_EXPIRATION_TTL;
    }
    return value;
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

    // The result is deterministic per request, but keyToRequest calls this on
    // every cache operation; memoize per request context (see derivedBaseUrlMemo).
    const memoized = derivedBaseUrlMemo.get(ctx);
    if (memoized !== undefined) {
      return memoized;
    }

    const derived = ((): string => {
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
    })();

    derivedBaseUrlMemo.set(ctx, derived);
    return derived;
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
   * match from a genuine miss for debug reporting; `error` is set when the
   * `match` itself rejected (a transient L1 infra error) so the caller can
   * report it as cache-read while still degrading to L2/KV -- distinct from a
   * genuine miss (no entry), which sets neither flag.
   * @internal
   */
  private async matchWithTimeout(
    cache: Cache,
    request: Request,
  ): Promise<{
    response: Response | undefined;
    timedOut: boolean;
    error?: unknown;
  }> {
    let matchError: unknown;
    const { value, timedOut } = await this.readWithTimeout(
      // A fast match rejection is caught at the thunk and reported as a miss
      // (response undefined), so the caller falls through to L2/KV rather than
      // escaping to the outer catch -- symmetric with the body-read thunk. The
      // error is captured (not swallowed) so the caller can surface it via
      // onError as a cache-read degradation.
      () =>
        cache.match(request).catch((e) => {
          matchError = e;
          return undefined;
        }),
      this.edgeLookupTimeoutMs,
      "edge cache lookup",
    );
    return { response: value, timedOut, error: matchError };
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
  ): Promise<{ value: T | undefined; errored: boolean; error?: unknown }> {
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
    let error: unknown;
    const { value } = await this.readWithTimeout<T | undefined>(
      () =>
        (response.json() as Promise<T>).catch((e) => {
          errored = true;
          error = e;
          return undefined;
        }),
      this.edgeReadTimeoutMs,
      "edge cache body read",
    );
    return { value, errored, error };
  }

  /**
   * Self-heal a corrupt L1 entry, then return the fall-through result. Reports
   * the corruption as cache-corrupt (so an onError consumer sees it distinctly
   * from a transient outage), runs the caller's L2/KV fall-through, and evicts
   * the faulty per-colo entry ONLY when that fall-through found no good copy.
   *
   * The conditional evict is the load-bearing detail: when KV DOES serve a copy,
   * kvGet* has already scheduled a same-key promote (`cache.put`); an eager
   * `cache.delete` here would race that put with no CF Cache API ordering
   * guarantee and could clobber the freshly-restored entry. So in that case we
   * lean on #558's heal-by-overwrite (the non-suppressed fall-through promotes /
   * a fresh render re-`set`s over the bad entry) and skip the delete. Only when
   * this request's fall-through found no copy (=== null) is the eager evict
   * scheduled -- useful then, since nothing else will overwrite the poison entry.
   * A null fall-through can also be a KV-read TIMEOUT rather than a genuine miss:
   * a concurrent request that read KV successfully may be promoting the same key,
   * and this evict could race it. That is benign -- the worst case is one wasted
   * colo-local promote, never a wrong served value, and the next read self-heals
   * -- so we accept it rather than suppressing the evict on a timeout (which
   * would strand the poison entry when KV really is empty). The evict is
   * non-blocking (waitUntil) so it never adds latency to the degraded read.
   * @internal
   */
  private async healCorruptL1<T>(
    cache: Cache,
    request: Request,
    error: unknown,
    label: string,
    fallThrough: () => Promise<T | null>,
  ): Promise<T | null> {
    reportCacheError(
      error ?? new Error("corrupt/partial L1 body"),
      "cache-corrupt",
      `[CFCacheStore] ${label}: corrupt L1 body`,
    );
    const result = await fallThrough();
    if (result === null) {
      const evict = (): Promise<void> =>
        reportingAsync(
          () => cache.delete(request),
          "cache-delete",
          `[CFCacheStore] ${label}: evict corrupt L1`,
        );
      if (this.waitUntil) this.waitUntil(evict);
      else void evict();
    }
    return result;
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

  /**
   * Document-tier counterpart of markRevalidating for getResponse's herd guard.
   * The segment/item tiers JSON-parse the body, so they re-put with a string
   * body; document bodies are streamed verbatim, so we re-put with a CLONED
   * response body (`response.clone()`) supplied by the caller -- the original
   * body still streams to the client while the marker carries the clone. Same
   * REVALIDATING status header, same revalidating-at stamp, same
   * remainingCacheControl re-put math as markRevalidating, so the document tier
   * suppresses concurrent revalidation for the identical MAX_REVALIDATION_INTERVAL
   * window the segment tier does. Best-effort and non-blocking: a failed marker
   * write must not affect the served stale read.
   * @internal
   */
  private markResponseRevalidating(
    cache: Cache,
    request: Request,
    clonedResponse: Response,
  ): void {
    const reputNow = Date.now();
    const headers = new Headers(clonedResponse.headers);
    headers.set(CACHE_STATUS_HEADER, "REVALIDATING");
    headers.set(CACHE_REVALIDATING_AT_HEADER, String(reputNow));
    headers.set("Cache-Control", remainingCacheControl(headers, reputNow));
    const markerResponse = new Response(clonedResponse.body, {
      status: clonedResponse.status,
      statusText: clonedResponse.statusText,
      headers,
    });
    const write = async (): Promise<void> => {
      try {
        await cache.put(request, markerResponse);
      } catch {
        // Best-effort: see markRevalidating.
      }
    };
    if (this.waitUntil) this.waitUntil(write);
    else void write();
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
      const matchStart = Date.now();
      const {
        response,
        timedOut,
        error: matchError,
      } = await this.matchWithTimeout(cache, request);
      const matchMs = Date.now() - matchStart;

      if (!response) {
        // A transient L1 match error (matchError set) is reported as cache-read
        // but, like a genuine miss or an abandoned slow match (timedOut), still
        // degrades to L2/KV rather than failing the read.
        if (matchError)
          reportCacheError(
            matchError,
            "cache-read",
            "[CFCacheStore] get L1 match",
          );
        if (this.debug)
          this.emitDebug({
            op: "get",
            key,
            // A match REJECTION (matchError) is distinct from a genuine absence:
            // surface it as match-error so debug agrees with the cache-read
            // already routed to onError, instead of masquerading as l1-miss.
            outcome: matchError
              ? "match-error"
              : timedOut
                ? "match-timeout"
                : "l1-miss",
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

      // Tag invalidation: an entry whose tags were invalidated after it was
      // cached is treated as a miss, so the next render re-populates it. We
      // return null (re-render locally) rather than falling through to KV. In
      // the common case the L1 entry and its KV twin were written together with
      // the same taggedAt, so kvGetSegment's own tag check would miss too and a
      // fall-through is pure cost. The tiers CAN diverge -- another colo may have
      // already re-rendered and written a fresher KV envelope -- in which case a
      // fall-through could serve that copy instead of re-rendering here.
      // Capturing that cross-colo optimization is a deferred follow-up, not a
      // correctness gap: this colo's next read after its own re-render self-heals.
      const tagInfo = this.readTagInfo(response.headers);
      // Measure the marker-resolution tail (memo -> L1 marker cache -> KV) only
      // when debug is on, so the hot path pays nothing. It is the serial read
      // that sits between matchMs and bodyReadMs for a tagged entry.
      const markerStart = this.debug ? Date.now() : 0;
      const invalidated = await this.isL1Invalidated(
        tagInfo.tags,
        tagInfo.taggedAt,
        response.headers,
      );
      const markerMs = this.debug ? Date.now() - markerStart : undefined;
      if (invalidated) {
        if (this.debug)
          this.emitDebug({
            op: "get",
            key,
            outcome: "tag-invalidated",
            status: response.status,
            matchMs,
            markerMs,
          });
        return null;
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
              markerMs,
              bodyReadMs,
            })
        : undefined;

      // Case 1: Fresh or already being revalidated - just return data
      if (!isStale || isRevalidating) {
        const bodyStart = Date.now();
        const {
          value: data,
          errored,
          error,
        } = await this.readJsonWithTimeout<CachedEntryData>(response);
        const bodyReadMs = Date.now() - bodyStart;
        if (data === undefined) {
          debugRead?.(errored ? "body-error" : "body-timeout", bodyReadMs);
          // A body-ERROR (corrupt/foreign body) self-heals via healCorruptL1:
          // report cache-corrupt, fall through to L2/KV (which overwrites the
          // bad entry), and evict only if KV had no good copy to promote. A
          // body-TIMEOUT is a degraded read of a likely-valid entry: leave it
          // intact and suppress revalidation so a stalling colo cannot herd.
          if (errored)
            return this.healCorruptL1(cache, request, error, "get", () =>
              this.kvGetSegment(key, { suppressRevalidate: false }),
            );
          return this.kvGetSegment(key, { suppressRevalidate: true });
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
      const {
        value: data,
        errored,
        error,
      } = await this.readJsonWithTimeout<CachedEntryData>(response);
      const bodyReadMs = Date.now() - bodyStart;
      if (data === undefined) {
        debugRead?.(errored ? "body-error" : "body-timeout", bodyReadMs);
        // Heal + conditionally evict a body-error, suppress a body-timeout; see
        // Case 1.
        if (errored)
          return this.healCorruptL1(
            cache,
            request,
            error,
            "get(revalidating)",
            () => this.kvGetSegment(key, { suppressRevalidate: false }),
          );
        return this.kvGetSegment(key, { suppressRevalidate: true });
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
      // reportCacheError logs and routes to onError (cache-read); the debug
      // emit is the separate wrangler-tail signal. Keep both observability paths.
      reportCacheError(error, "cache-read", "[CFCacheStore] get");
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
    if (this.isReservedSegmentKey(key, "cache-write")) return;
    if (this.skipUncacheableTagSet(data.tags)) return;
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
        Array.isArray(data.tags) && data.tags.length > 0
          ? Date.now()
          : undefined;
      const dataToStore: CachedEntryData = taggedAt
        ? { ...data, taggedAt }
        : data;

      // Serialize the segment payload exactly once: L1 stores the JSON body
      // directly, and kvSetSegment embeds the same string as envelope.d so the
      // (potentially large) Flight/segment tree is not walked a second time.
      const body = JSON.stringify(dataToStore);
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

      // L2: persist to KV (reuses `body` as envelope.d)
      this.kvSetSegment(key, body, staleAt, totalTtl, swrWindow);
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
      // The document path is outside the debug surface (op is only get/getItem),
      // so the match-timeout flag is not surfaced as an event here -- though
      // matchWithTimeout still warns on a slow match. A miss or timeout falls
      // through to the KV document path and then render.
      const { response, error: matchError } = await this.matchWithTimeout(
        cache,
        request,
      );

      if (!response || response.status !== 200) {
        // A transient L1 match rejection (matchError set; only ever set when
        // response is undefined) is surfaced as cache-read before degrading to
        // L2/KV -- matching get()/getItem(). A genuine miss or a non-200 hit
        // carries no matchError and reports nothing.
        if (matchError)
          reportCacheError(
            matchError,
            "cache-read",
            "[CFCacheStore] getResponse L1 match",
          );
        return this.kvGetResponse(key);
      }

      // Tag invalidation check (treat invalidated entry as a miss).
      const tagInfo = this.readTagInfo(response.headers);
      if (
        await this.isL1Invalidated(
          tagInfo.tags,
          tagInfo.taggedAt,
          response.headers,
        )
      ) {
        return null;
      }

      // Check staleness
      const staleAt = Number(response.headers.get(CACHE_STALE_AT_HEADER) || 0);
      const now = Date.now();
      const isStale = staleAt > 0 && now > staleAt;

      // Thundering-herd guard, mirroring the segment (get) and item (getItem)
      // tiers. Without it, every concurrent stale reader returned
      // shouldRevalidate=true and document-cache.ts scheduled a fresh render for
      // each one. Recency comes from our own revalidating-at stamp, not CF's Age
      // header (see CACHE_REVALIDATING_AT_HEADER); an absent/zero stamp counts as
      // "not recent" so a dropped revalidation re-arms instead of pinning.
      const status = response.headers.get(CACHE_STATUS_HEADER);
      const revalidatingAt = Number(
        response.headers.get(CACHE_REVALIDATING_AT_HEADER) ?? "0",
      );
      const isRevalidating =
        status === "REVALIDATING" &&
        revalidatingAt > 0 &&
        now - revalidatingAt < MAX_REVALIDATION_INTERVAL * 1000;

      // L1 document bodies are streamed through verbatim - unlike the segment/
      // item tiers (which JSON-parse and so structurally detect corruption) and
      // the KV doc tier (validated in kvGetResponse, KV being the real partial-
      // read vector). Integrity here relies on the Cache API: cache.put stores a
      // response atomically or fails, so a truncated body is not served back. We
      // deliberately do NOT buffer+hash the body to re-verify it: that would
      // defeat streaming the document and add a full read to every cache hit.

      if (isStale && !isRevalidating) {
        // First stale reader within the window: mark REVALIDATING (non-blocking,
        // best-effort) so concurrent readers below see the guard and suppress,
        // then return shouldRevalidate=true so this caller revalidates. Clone the
        // matched response for the marker since its original body must still
        // stream to the client.
        this.markResponseRevalidating(cache, request, response.clone());
        return {
          response: this.toClientResponse(response),
          shouldRevalidate: true,
        };
      }

      // Fresh, or stale-but-already-REVALIDATING: serve without scheduling a
      // (re-)revalidation. A recent marker already has a render in flight.
      return {
        response: this.toClientResponse(response),
        shouldRevalidate: false,
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
    // Remove OUR namespaced tokens from Cache-Tag while preserving any the
    // document author set (setTagHeaders appended ours onto theirs). The
    // author's tags may be load-bearing for their own CDN purging; ours are
    // internal storage bookkeeping and must not leak to clients.
    this.stripInternalCacheTags(headers);
    // Internal stale-path bookkeeping (hard-expiry deadline + REVALIDATING
    // stamp). Carried on doc L1 entries for the herd guard; never serve them.
    headers.delete(CACHE_EXPIRES_AT_HEADER);
    headers.delete(CACHE_REVALIDATING_AT_HEADER);
    // Finding #3 (read side): strip per-client signals a pre-fix or
    // pinned-version L1 entry may carry. See the read-side note in the design doc.
    stripPerClientSignals(headers);
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
    if (this.skipUncacheableTagSet(tags)) return;
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(`doc:${key}`);

      // Extended TTL covers SWR window
      const swrWindow = resolveSwrWindow(swr, this.defaults);
      const totalTtl = ttl + swrWindow;
      const staleAt = Date.now() + ttl * 1000;
      const taggedAt =
        Array.isArray(tags) && tags.length > 0 ? Date.now() : undefined;

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
      // Finding #3: never persist a per-client signal in the shared L1 entry
      // (the platform's Set-Cookie rejection is unverified and ignores the
      // directive anyway). See stripPerClientSignals.
      stripPerClientSignals(headers);
      const originalCacheControl = response.headers.get("Cache-Control");
      if (originalCacheControl !== null) {
        headers.set(CACHE_ORIG_CC_HEADER, originalCacheControl);
      }
      headers.set("Cache-Control", `public, max-age=${totalTtl}`);
      headers.set(CACHE_STALE_AT_HEADER, String(staleAt));
      // Absolute hard-expiry deadline so a stale-path REVALIDATING re-put can
      // recompute a shrinking max-age (remainingCacheControl) instead of
      // restarting retention. Mirrors set()/setItem(). Stripped by
      // toClientResponse before serving.
      headers.set(CACHE_EXPIRES_AT_HEADER, String(staleAt + swrWindow * 1000));
      // Internal tag headers (stripped by toClientResponse before serving).
      this.setTagHeaders(headers, tags, taggedAt);

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
        const kvKey = this.toDocKVKey(key);
        // Finding #3: never persist a per-client signal in the KV envelope.
        const headersArray: [string, string][] = [];
        response.headers.forEach((v, k) => {
          if (isPerClientSignalHeader(k)) return;
          headersArray.push([k, v]);
        });
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
      const matchStart = Date.now();
      const {
        response,
        timedOut,
        error: matchError,
      } = await this.matchWithTimeout(cache, request);
      const matchMs = Date.now() - matchStart;

      if (!response) {
        // Transient match error reported cache-read; still degrades to L2/KV.
        if (matchError)
          reportCacheError(
            matchError,
            "cache-read",
            "[CFCacheStore] getItem L1 match",
          );
        if (this.debug)
          this.emitDebug({
            op: "getItem",
            key,
            // match-error (rejection) vs l1-miss (absence); see get().
            outcome: matchError
              ? "match-error"
              : timedOut
                ? "match-timeout"
                : "l1-miss",
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

      // Tag invalidation check (treat invalidated entry as a miss). Measure the
      // marker-resolution tail only under debug (see get()).
      const tagInfo = this.readTagInfo(response.headers);
      const markerStart = this.debug ? Date.now() : 0;
      const invalidated = await this.isL1Invalidated(
        tagInfo.tags,
        tagInfo.taggedAt,
        response.headers,
      );
      const markerMs = this.debug ? Date.now() - markerStart : undefined;
      if (invalidated) {
        if (this.debug)
          this.emitDebug({
            op: "getItem",
            key,
            outcome: "tag-invalidated",
            status: response.status,
            matchMs,
            markerMs,
          });
        return null;
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
              markerMs,
              bodyReadMs,
            })
        : undefined;

      const bodyStart = Date.now();
      const {
        value: data,
        errored,
        error,
      } = await this.readJsonWithTimeout<{
        value: string;
        handles?: string;
      }>(response);
      const bodyReadMs = Date.now() - bodyStart;
      if (data === undefined) {
        debugRead?.(errored ? "body-error" : "body-timeout", bodyReadMs);
        // Heal + conditionally evict a body-error, suppress a body-timeout; see
        // get().
        if (errored)
          return this.healCorruptL1(cache, request, error, "getItem", () =>
            this.kvGetItem(key, { suppressRevalidate: false }),
          );
        return this.kvGetItem(key, { suppressRevalidate: true });
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
          tags: tagInfo.tags,
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
        tags: tagInfo.tags,
      };
    } catch (error) {
      reportCacheError(error, "cache-read", "[CFCacheStore] getItem");
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
    if (this.skipUncacheableTagSet(options?.tags)) return;
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(`fn:${key}`);

      const ttl = resolveTtl(options?.ttl, this.defaults, DEFAULT_FUNCTION_TTL);
      const swrWindow = resolveSwrWindow(options?.swr, this.defaults);
      const totalTtl = ttl + swrWindow;
      const staleAt = Date.now() + ttl * 1000;

      const tags = options?.tags;
      const taggedAt =
        Array.isArray(tags) && tags.length > 0 ? Date.now() : undefined;

      // Serialize value/handles once; L1 body and KV envelope.v/h share the
      // escaped strings so a large RSC payload is not re-escaped for L2.
      const valueJson = JSON.stringify(value);
      const handlesJson =
        options?.handles !== undefined
          ? JSON.stringify(options.handles)
          : undefined;
      const body =
        handlesJson !== undefined
          ? `{"value":${valueJson},"handles":${handlesJson}}`
          : `{"value":${valueJson}}`;
      const response = new Response(body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${totalTtl}`,
          [CACHE_STALE_AT_HEADER]: String(staleAt),
          // Absolute hard-expiry deadline; see set() / remainingCacheControl.
          [CACHE_EXPIRES_AT_HEADER]: String(staleAt + swrWindow * 1000),
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

      // L2: persist to KV (KV requires expirationTtl >= 60s). Wire shape matches
      // JSON.stringify(KVItemEnvelope); field names differ from L1 so we assemble
      // from the pre-escaped value/handles pieces rather than re-stringifying.
      if (this.kv && this.waitUntil && totalTtl >= 60) {
        const kvKey = this.toKVKey(`fn:${key}`);
        const expiresAt = staleAt + swrWindow * 1000;
        let envelopeJson = `{"v":${valueJson}`;
        if (handlesJson !== undefined) envelopeJson += `,"h":${handlesJson}`;
        envelopeJson += `,"s":${staleAt},"e":${expiresAt}`;
        if (tags !== undefined) envelopeJson += `,"t":${JSON.stringify(tags)}`;
        if (taggedAt !== undefined) envelopeJson += `,"ta":${taggedAt}`;
        envelopeJson += `}`;
        this.waitUntil(() =>
          reportingAsync(
            () =>
              this.kv!.put(kvKey, envelopeJson, {
                expirationTtl: totalTtl,
              }),
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
  // Shell Cache Methods (PPR shell resume) — KV-only in v1
  // ============================================================================
  //
  // Unlike the segment/item/document tiers, the shell family has NO Cache-API L1
  // tier: the prelude bytes + postponed blob are large and version-coupled, and a
  // per-colo L1 for them is a deliberate follow-up (see the PPR shell-resume
  // design doc). Shell entries live only in KV (the global tier), so the family
  // requires a configured KV namespace; without one, getShell/putShell no-op and
  // the integrated PPR serve path fails open to a full HTML render. Tag invalidation
  // still applies: shell entries carry tags/taggedAt and are checked against the
  // same KV markers isGloballyInvalidated() reads for every other tier.

  /**
   * Warn once per isolate that the shell family is inert: getShell/putShell
   * are ONLY called for routes that declared the `ppr` path option, so firing
   * here (not in the constructor) scopes the warning to apps that actually
   * use PPR — a KV-less CFCacheStore is a perfectly fine config otherwise.
   * Without it, the correctness-first fail-open (issue #651) is invisible:
   * every ppr route is a permanent MISS with zero diagnostics.
   * @internal
   */
  private warnShellFamilyInertOnce(): void {
    this.warnOncePerNamespace(
      warnedShellFamilyInert,
      `[CFCacheStore] a ppr route resolved to this store, but no KV namespace ` +
        `is configured, so the shell family (getShell/putShell) is a no-op: ` +
        `every ppr route stays a permanent shell MISS (the page still serves ` +
        `via a full render). Bind a KV namespace and pass it — ` +
        `new CFCacheStore({ ctx, kv: env.CACHE_KV }) — or use a shell-capable ` +
        `store via createRouter({ cache }).`,
    );
  }

  /**
   * Get a cached PPR shell entry by key from KV (no L1). Applies the KV read
   * budget, corrupt-entry eviction, hard-expiry, and tag invalidation exactly
   * like kvGetItem, minus the L1 promote. SWR is a plain staleness flag — KV has
   * no REVALIDATING herd guard, so the capture scheduler's module-level
   * in-flight set is the recapture stampede guard.
   */
  async getShell(
    key: string,
  ): Promise<{ entry: ShellCacheEntry; shouldRevalidate?: boolean } | null> {
    if (!this.kv) {
      this.warnShellFamilyInertOnce();
      return null;
    }
    try {
      const kvKey = this.toKVKey(`shell:${key}`);
      const { value: envelope, timedOut } =
        await this.kvGetOrEvict<KVShellEnvelope>(
          kvKey,
          (e) =>
            typeof e.p === "string" &&
            (e.po === null || typeof e.po === "string") &&
            typeof e.rv === "string" &&
            typeof e.e === "number" &&
            typeof e.s === "number",
          "getShell",
        );
      // A timeout, a missing key, or an already-evicted corrupt entry is a miss.
      if (timedOut || !envelope) return null;

      const now = Date.now();
      if (now > envelope.e) return null;

      if (await this.isGloballyInvalidated(envelope.t, envelope.ta)) {
        return null;
      }

      const shouldRevalidate = envelope.s > 0 && now > envelope.s;
      return {
        entry: {
          prelude: envelope.p,
          postponed: envelope.po,
          reactVersion: envelope.rv,
          buildVersion: envelope.bv,
          initialTheme: envelope.i,
          snapshot: envelope.sn,
          handlerLiveHoles: envelope.lh,
          transitionWhen: envelope.tw,
          navigationOnly: envelope.no,
          createdAt: envelope.c,
        },
        shouldRevalidate,
      };
    } catch (error) {
      reportCacheError(error, "cache-read", "[CFCacheStore] getShell");
      return null;
    }
  }

  /**
   * Store a PPR shell entry in KV with TTL and optional SWR window. The write is
   * registered with waitUntil and awaited so invalidation rejection can be
   * acknowledged to the capture scheduler. The tags/taggedAt ride in the envelope
   * so isGloballyInvalidated() can invalidate the shell via the shared KV markers.
   */
  async putShell(
    key: string,
    entry: ShellCacheEntry,
    ttlSeconds?: number,
    swrSeconds?: number,
    tags?: string[],
  ): Promise<"stored" | "invalidated" | void> {
    // KV-only tier: needs a KV namespace and waitUntil. The same write promise is
    // registered for isolate lifetime and awaited so invalidation rejection can
    // be acknowledged to the capture scheduler.
    if (!this.kv) {
      this.warnShellFamilyInertOnce();
      return;
    }
    if (!this.waitUntil) return;
    try {
      const ttl = resolveTtl(ttlSeconds, this.defaults, DEFAULT_FUNCTION_TTL);
      const swrWindow = resolveSwrWindow(swrSeconds, this.defaults);
      const totalTtl = ttl + swrWindow;
      // KV requires expirationTtl >= 60s; skip a shorter-lived shell rather than
      // letting kv.put reject inside waitUntil (mirrors setItem/kvSetSegment).
      if (totalTtl < 60) return;

      const retentionTtl =
        tags && tags.length > 0 && this.tagInvalidationTtl
          ? Math.min(totalTtl, this.tagInvalidationTtl)
          : totalTtl;
      const now = Date.now();
      const staleAt = now + ttl * 1000;
      const expiresAt = now + retentionTtl * 1000;
      const taggedAt =
        Array.isArray(tags) && tags.length > 0 ? entry.createdAt : undefined;

      const kvKey = this.toKVKey(`shell:${key}`);
      // A key over the KV limit makes kv.put reject deep inside waitUntil; report
      // and skip the doomed write (mirrors kvSetSegment).
      const kvKeyBytes = kvKeyByteLength(kvKey);
      if (kvKeyBytes > KV_MAX_KEY_BYTES) {
        reportCacheError(
          new Error(
            `shell cache key produces a ${kvKeyBytes}-byte KV key, over the ` +
              `${KV_MAX_KEY_BYTES}-byte limit; the shell was not persisted.`,
          ),
          "cache-write",
          "[CFCacheStore] putShell",
        );
        return;
      }

      const write = (async (): Promise<"stored" | "invalidated" | void> => {
        try {
          if (
            tags &&
            tags.length > 0 &&
            (await this.isGloballyInvalidated(tags, entry.createdAt))
          ) {
            return "invalidated";
          }
          const envelope: KVShellEnvelope = {
            p: entry.prelude,
            po: entry.postponed,
            rv: entry.reactVersion,
            bv: entry.buildVersion,
            c: entry.createdAt,
            s: staleAt,
            e: expiresAt,
            t: tags,
            ta: taggedAt,
            i: entry.initialTheme,
            sn: entry.snapshot,
            lh: entry.handlerLiveHoles,
            tw: entry.transitionWhen,
            no: entry.navigationOnly,
          };
          await this.kv!.put(kvKey, JSON.stringify(envelope), {
            expirationTtl: retentionTtl,
          });
          return "stored";
        } catch (error) {
          reportCacheError(error, "cache-write", "[CFCacheStore] putShell");
          return undefined;
        }
      })();
      this.waitUntil(async () => {
        await write;
      });
      return await write;
    } catch (error) {
      reportCacheError(error, "cache-write", "[CFCacheStore] putShell");
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

  /**
   * Host token for the current request, used to namespace the document KV key.
   * Derived from the same resolveBaseUrl() that namespaces the L1 (Cache API)
   * tier, so a doc entry's KV twin lands under the identical host bucket.
   * Falls back to "_" if the base URL cannot be parsed (it always carries a
   * trailing-slash origin, so parsing succeeds in practice).
   * @internal
   */
  private docKVHost(): string {
    try {
      return new URL(this.resolveBaseUrl()).host || "_";
    } catch {
      return "_";
    }
  }

  /**
   * Convert a document key to its host-namespaced KV key. The L1 tier already
   * namespaces document entries by host via keyToRequest/resolveBaseUrl, but the
   * KV fallback keyed only on `doc:{key}`, so two hosts serving the same path
   * could collide on the KV tier (one host serving another's cached document).
   * Prefixing the host closes that cross-host collision. Deterministic per
   * (host, key). Segment/fn/tag-marker KV keys keep toKVKey unchanged: tag
   * markers are intentionally global (invalidation must cross hosts), and the
   * document tier is the one with a request-host context here.
   * @internal
   */
  private toDocKVKey(key: string): string {
    return this.toKVKey(`h/${this.docKVHost()}/doc:${key}`);
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
   * Schedule a corrupt-entry KV eviction as a NON-BLOCKING background task
   * (waitUntil) instead of awaiting it on the request path. The corrupt read has
   * already resolved to a miss; awaiting an unbounded kv.delete here would re-add
   * exactly the multi-second stall the read budgets exist to prevent when the KV
   * namespace is degraded. evictKvKey never rejects (it reports its own failure),
   * so the fire-and-forget fallback is safe when no waitUntil is available.
   * @internal
   */
  private scheduleKvEvict(kvKey: string, label: string): void {
    const evict = (): Promise<void> => this.evictKvKey(kvKey, label);
    if (this.waitUntil) this.waitUntil(evict);
    else void evict();
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
  ): Promise<{ value: T | null; timedOut: boolean }> {
    // Bound the read with the KV latency budget (inherited from #558) so a
    // degraded namespace cannot pin the request. readWithTimeout reports
    // timedOut on budget expiry; a transient read REJECTION (5xx/429/network)
    // instead propagates out to the caller's outer catch (reported cache-read,
    // the entry left intact) -- deliberately NOT caught as corruption.
    const { value: raw, timedOut } = await this.readWithTimeout<unknown>(
      () => this.kv!.get(kvKey, { type: "text" }),
      this.kvReadTimeoutMs,
      "KV read",
    );
    if (timedOut) return { value: null, timedOut: true };
    if (raw == null) return { value: null, timedOut: false }; // missing = miss

    // Real CF KV with { type: "text" } returns a string: parse + structurally
    // validate it; a parse/validate failure on a successfully-read body is the
    // only true corruption (evict + cache-corrupt). A KV binding that already
    // returns a parsed object (some shims/tests) is used as-is.
    let envelope: T;
    if (typeof raw === "string") {
      try {
        envelope = JSON.parse(raw) as T;
      } catch (error) {
        reportCacheError(
          error,
          "cache-corrupt",
          `[CFCacheStore] ${label}: corrupt JSON in KV, evicting`,
        );
        this.scheduleKvEvict(kvKey, label);
        return { value: null, timedOut: false };
      }
    } else {
      envelope = raw as T;
    }

    // A body that parses to null or a primitive ('null', '42', 'true', '"x"')
    // is not a valid envelope. Guard it BEFORE validate(): the property-reading
    // validators throw on a null/primitive rather than returning false, which
    // would escape to the caller's outer catch as a transient cache-read and
    // leave the bad key un-evicted (re-failing every read until its KV TTL). The
    // typeof check short-circuits validate() so it only ever runs on an object.
    if (
      envelope == null ||
      typeof envelope !== "object" ||
      !validate(envelope)
    ) {
      reportCacheError(
        new Error("malformed/partial KV envelope"),
        "cache-corrupt",
        `[CFCacheStore] ${label}: malformed envelope, evicting`,
      );
      this.scheduleKvEvict(kvKey, label);
      return { value: null, timedOut: false };
    }
    return { value: envelope, timedOut: false };
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
   *
   * Also stamps the namespaced `Cache-Tag` header (see entryCacheTags) so a
   * Cloudflare purge-by-tag can evict the entry — the mechanism purge mode
   * (tagPurge) relies on. Written unconditionally (not only in purge mode):
   * it costs a small header and makes existing entries purgeable the moment a
   * consumer turns purge mode on, with no re-render needed.
   */
  private tagHeaderEntries(
    tags: string[] | undefined,
    taggedAt: number | undefined,
  ): Record<string, string> {
    if (!Array.isArray(tags) || tags.length === 0 || !taggedAt) return {};
    const entries: Record<string, string> = {
      // encodeURIComponent so the value is pure ASCII: HTTP header values are
      // ByteStrings, but JSON.stringify leaves codepoints > U+00FF (emoji/CJK)
      // verbatim, which makes new Response({ headers }) throw and the outer
      // try/catch silently drop the whole entry from cache. Decoded in
      // readTagInfo. The L1 marker Cache-Tag path encodes for the same reason.
      [CACHE_TAGS_HEADER]: encodeURIComponent(JSON.stringify(tags)),
      [CACHE_TAGGED_AT_HEADER]: String(taggedAt),
    };
    // Over Cloudflare's aggregate Cache-Tag limit the header is OMITTED — the
    // entry still caches and stays marker-invalidatable; it just cannot be
    // purge-evicted per tag (isL1Invalidated falls back to the marker check
    // for such entries, so purge mode stays correct). Emitting a header over
    // the limit would instead risk failing the whole L1 write. The KV-LESS
    // purge-mode combination never reaches here: there the marker fallback
    // has no KV to consult, so skipUncacheableTagSet rejects the write first.
    const cacheTag = this.entryCacheTagHeader(tags);
    if (cacheTag !== null) {
      entries["Cache-Tag"] = cacheTag;
    } else {
      this.warnOncePerNamespace(
        warnedCacheTagHeaderOverflow,
        `[CFCacheStore] an entry's ${tags.length} tags produce a Cache-Tag ` +
          `header over Cloudflare's ${CACHE_TAG_HEADER_MAX_BYTES}-byte ` +
          `limit; the header was omitted. The entry stays cacheable and ` +
          `marker-invalidatable, but a purge-by-tag cannot evict it (purge ` +
          `mode falls back to the marker check for it). Reduce the number ` +
          `of tags per entry.`,
      );
    }
    return entries;
  }

  /**
   * Joined entry Cache-Tag header value for `tags`, or null when it would
   * exceed Cloudflare's aggregate header limit. Tokens are pure ASCII
   * (encodeURIComponent output), so .length is bytes.
   * @internal
   */
  private entryCacheTagHeader(tags: string[]): string | null {
    const joined = this.entryCacheTags(tags).join(",");
    return joined.length <= CACHE_TAG_HEADER_MAX_BYTES ? joined : null;
  }

  /**
   * Write-path gate for the one configuration where an over-limit tag set has
   * NO invalidation path: purge mode WITHOUT KV. There the entry Cache-Tag
   * tokens are the only eviction mechanism, and a tag set whose header
   * overflows CACHE_TAG_HEADER_MAX_BYTES gets no tokens — a purge could never
   * evict the entry and there is no KV marker fallback, so it would serve
   * stale until TTL while updateTag() reports success. Returns true (and
   * warns once) so the caller SKIPS caching: the route simply renders fresh,
   * which is the fail-safe direction. With KV configured the omitted-header
   * entry falls back to the marker check (see tagHeaderEntries), and KV-less
   * MARKER mode keeps its documented no-read-side-invalidation semantics —
   * neither is gated.
   * @internal
   */
  private skipUncacheableTagSet(tags: string[] | undefined): boolean {
    if (!this.tagPurge || this.kv) return false;
    if (!Array.isArray(tags) || tags.length === 0) return false;
    if (this.entryCacheTagHeader(tags) !== null) return false;
    this.warnOncePerNamespace(
      warnedCacheTagOverflowUncacheable,
      `[CFCacheStore] an entry's ${tags.length} tags produce a Cache-Tag ` +
        `header over Cloudflare's ${CACHE_TAG_HEADER_MAX_BYTES}-byte limit. ` +
        `In purge mode without KV those tokens are the only invalidation ` +
        `path, so the entry was NOT cached (it renders fresh instead of ` +
        `becoming un-invalidatable). Reduce the number of tags per entry, ` +
        `or configure { kv } to get the marker fallback.`,
    );
    return true;
  }

  /**
   * Merge the internal tag headers onto an existing Headers instance. The
   * from-scratch paths spread tagHeaderEntries() into an object-literal init;
   * the document put/promote paths build a Headers first, so they .set() each
   * entry instead — except `Cache-Tag`, which is APPENDED: a document author
   * may have set their own Cache-Tag, and clobbering it would break their CDN
   * purging. Append produces the comma-merged list CF expects.
   */
  private setTagHeaders(
    headers: Headers,
    tags: string[] | undefined,
    taggedAt: number | undefined,
  ): void {
    for (const [name, value] of Object.entries(
      this.tagHeaderEntries(tags, taggedAt),
    )) {
      if (name === "Cache-Tag") headers.append(name, value);
      else headers.set(name, value);
    }
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
      const taggedAt = Number(rawTaggedAt);
      // A corrupt/non-numeric tagged-at header yields NaN. isGloballyInvalidated
      // short-circuits on a falsy taggedAt (NaN is falsy), so returning
      // { taggedAt: NaN } would make the entry permanently NON-invalidatable -
      // a revalidateTag could never evict it. Treat a non-finite stamp the same
      // as the missing-header case (untagged): drop both tags and taggedAt so the
      // entry is re-rendered/re-tagged rather than silently un-invalidatable.
      if (!Number.isFinite(taggedAt)) return {};
      return {
        tags: JSON.parse(decodeURIComponent(rawTags)) as string[],
        taggedAt,
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
    // Array.isArray (not just truthiness): a non-array tags value - direct store
    // misuse like setItem(k, v, { tags: "products" }), or a skewed KV envelope -
    // must fail safe to "not invalidated" rather than throwing `.map` on every
    // read (which the outer catch would mis-report as a transient cache-read).
    if (!this.kv || !Array.isArray(tags) || tags.length === 0 || !taggedAt)
      return false;
    const ctx = _getRequestContext();
    const memo = ctx ? getTagMarkerMemo(ctx, this) : undefined;
    const inflight = ctx ? getTagMarkerInflight(ctx, this) : undefined;
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

  /**
   * Tag-invalidation check for an L1 (Cache API) hit. In purge mode (tagPurge
   * configured), invalidateTags() evicts L1 entries via a Cloudflare
   * purge-by-tag call, so a hit that SURVIVED is trusted without a per-read
   * marker lookup — that skipped lookup is the entire point of purge mode.
   * Only the per-request memo is consulted (synchronous, no KV read) so a
   * request that ran updateTag() still masks its own entries during the purge
   * propagation window (read-your-own-writes).
   *
   * The trust is conditional on the entry actually CARRYING this store's
   * entry Cache-Tag tokens (`headers`): an entry a purge cannot reach — one
   * written before the tokens existed, or whose tag set overflowed the
   * Cache-Tag header limit — keeps the full marker check, or purge mode
   * would serve it stale until TTL with no eviction path.
   *
   * Without tagPurge this is the full marker cascade. KV-tier reads and
   * shells always use isGloballyInvalidated directly: purge cannot reach KV,
   * so the markers stay their invalidation mechanism.
   * @internal
   */
  private async isL1Invalidated(
    tags: string[] | undefined,
    taggedAt: number | undefined,
    headers: Headers,
  ): Promise<boolean> {
    if (!this.tagPurge) return this.isGloballyInvalidated(tags, taggedAt);
    if (!Array.isArray(tags) || tags.length === 0 || !taggedAt) return false;
    if (!this.hasEntryCacheTags(headers)) {
      return this.isGloballyInvalidated(tags, taggedAt);
    }
    const ctx = _getRequestContext();
    if (!ctx) return false;
    const memo = getTagMarkerMemo(ctx, this);
    for (const tag of tags) {
      const marker = memo.get(tag);
      if (marker != null && marker >= taggedAt) return true;
    }
    return false;
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
    // Write the resolved marker into the memo WITHOUT clobbering a value a
    // concurrent invalidateTags() wrote during our await. The router resolves
    // sibling slots in parallel, so a slot's updateTag() can land the
    // authoritative invalidatedAt into the memo while this read is still in
    // flight; overwriting it with our (pre-invalidation) read result would break
    // read-your-own-writes for the rest of the request. If the tag was memoized
    // mid-read, that value wins and is returned. Without a memo, the read result
    // stands as-is.
    const memoize = (read: number | null): number | null => {
      if (memo && memo.has(tag)) return memo.get(tag) ?? null;
      memo?.set(tag, read);
      return read;
    };

    // L1 (per-colo) marker cache - opt-in via tagCacheTtl. Bounded by the same
    // edge budgets as data reads (inherited from #558) so a degraded colo cannot
    // stall a tagged read; a miss, timeout, or error all fall through to KV.
    if (this.tagCacheTtl > 0) {
      try {
        const cache = await this.getCache();
        const { response: hit, error: matchError } =
          await this.matchWithTimeout(cache, this.tagMarkerRequest(tag));
        // A transient match REJECTION is captured (not thrown) by
        // matchWithTimeout; surface it as cache-read like the data read paths
        // before falling through to KV, rather than silently dropping it.
        if (matchError)
          reportCacheError(
            matchError,
            "cache-read",
            "[CFCacheStore] tag marker L1 match",
          );
        if (hit) {
          const { value: body } = await this.readWithTimeout(
            () => hit.text(),
            this.edgeReadTimeoutMs,
            "tag marker L1 body read",
          );
          if (body !== undefined) {
            const value = body === TAG_MARKER_ABSENT ? null : Number(body);
            return memoize(value);
          }
        }
      } catch {
        // Fall through to KV on any L1 read error.
      }
    }

    // KV (global truth), bounded by the KV budget. On TIMEOUT fail OPEN: treat
    // the marker as absent (-> entry not invalidated -> served) so a degraded
    // namespace cannot pin every tagged read behind a slow global lookup. A
    // transient REJECTION instead propagates to isGloballyInvalidated's catch
    // (reported cache-read), which also fails open. Either way one slow tag
    // never amplifies into a per-segment stall.
    const { value: raw, timedOut } = await this.readWithTimeout<string | null>(
      () => this.kv!.get(this.tagMarkerKey(tag), { type: "text" }),
      this.kvReadTimeoutMs,
      "tag marker KV read",
    );
    if (timedOut) {
      // Memoize the fail-open result so the rest of this request is consistent
      // (and does not re-pay the timeout per segment sharing the tag).
      return memoize(null);
    }
    const value = raw != null ? Number(raw) : null;
    const resolved = memoize(value);

    // Populate L1 for subsequent reads in this colo (non-blocking). Use the
    // resolved (memo-aware) value so a marker invalidated mid-read is not
    // re-cached stale into this colo's L1.
    if (this.tagCacheTtl > 0) {
      const put = () => this.putTagMarkerL1(tag, resolved);
      if (this.waitUntil) this.waitUntil(put);
      else void put();
    }
    return resolved;
  }

  /**
   * Namespace token used inside every `rg:*` Cache-Tag. encodeURIComponent'd
   * like the tag values: a raw namespace containing a comma would split into
   * bogus tokens inside the comma-delimited Cache-Tag header — breaking both
   * stripInternalCacheTags (internal tokens would leak to clients) and the
   * purge match (the purged tag string never equals any stored token).
   * @internal
   */
  private nsToken(): string {
    return encodeURIComponent(this.namespace ?? "default");
  }

  /**
   * Cloudflare Cache-Tags written on a tag's L1 marker entry, namespaced per
   * store so purges never collide with other Cache-Tags in the zone. Three
   * tiers, broad to specific:
   *   rg:{ns}            - everything this store cached (deploy/nuclear reset)
   *   rg:{ns}:lk         - all tag-lookup markers
   *   rg:{ns}:lk:{tag}   - this tag's lookup (the normal updateTag purge target)
   * The namespace and tag value are encodeURIComponent'd so commas/spaces
   * can't corrupt the comma-delimited Cache-Tag header.
   * @internal
   */
  private lookupCacheTags(tag: string): string[] {
    const ns = this.nsToken();
    return [`rg:${ns}`, `rg:${ns}:lk`, this.lookupPurgeTag(tag)];
  }

  /**
   * Build one `{prefix}{tag}` Cache-Tag token, bounded to CACHE_TAG_TOKEN_MAX:
   * an over-long encoded tag collapses to `{prefix}h:{fnv1a64(tag)}` so a
   * legally-long application tag can never blow Cloudflare's per-tag purge
   * limit (1,024 chars) or bloat the header. Deterministic, so the write-time
   * token and the invalidate-time purge token always agree.
   * @internal
   */
  private boundedTagToken(prefix: string, tag: string): string {
    const token = `${prefix}${encodeURIComponent(tag)}`;
    if (token.length <= CACHE_TAG_TOKEN_MAX) return token;
    return `${prefix}h:${fnv1a64(tag)}`;
  }

  /** The specific Cache-Tag a consumer purges to evict tag `tag`'s lookup. */
  private lookupPurgeTag(tag: string): string {
    return this.boundedTagToken(`rg:${this.nsToken()}:lk:`, tag);
  }

  /**
   * Cloudflare Cache-Tags written on a tagged DATA entry (segment/item/doc),
   * mirroring the lookup-marker tiers but under `:e` (entry):
   *   rg:{ns}       - everything this store cached (deploy/nuclear reset)
   *   rg:{ns}:e     - all data entries
   *   rg:{ns}:e:{t} - entries carrying tag `t` (the purge-mode invalidation
   *                   target; see CFCacheStoreOptions.tagPurge)
   * Namespace and tag value encodeURIComponent'd like the lookup tier.
   * @internal
   */
  private entryCacheTags(tags: string[]): string[] {
    const ns = this.nsToken();
    return [
      `rg:${ns}`,
      `rg:${ns}:e`,
      ...tags.map((tag) => this.entryPurgeTag(tag)),
    ];
  }

  /** The specific Cache-Tag purged to evict entries carrying tag `tag`. */
  private entryPurgeTag(tag: string): string {
    return this.boundedTagToken(`rg:${this.nsToken()}:e:`, tag);
  }

  /**
   * Whether an L1 entry's stored headers carry this store's entry Cache-Tag
   * tokens — i.e. whether a purge-by-tag can actually evict it. False for an
   * entry written before this feature existed, or one whose tag set exceeded
   * CACHE_TAG_HEADER_MAX_BYTES (header omitted). Purge mode only trusts
   * entries a purge can reach; the rest keep the marker check.
   * @internal
   */
  private hasEntryCacheTags(headers: Headers): boolean {
    const raw = headers.get("Cache-Tag");
    if (raw === null) return false;
    const tier = `rg:${this.nsToken()}:e`;
    return raw.split(",").some((token) => {
      const trimmed = token.trim();
      return trimmed === tier || trimmed.startsWith(`${tier}:`);
    });
  }

  /**
   * Drop this store's namespaced tokens (`rg:{ns}` and `rg:{ns}:*`) from a
   * Cache-Tag header, keeping author-set tokens intact. Deletes the header
   * when nothing remains. Serve-path counterpart of setTagHeaders' append.
   * An author token that exactly equals a reserved `rg:{ns}` tier is stripped
   * too — `rg:` is this store's documented-reserved Cache-Tag prefix.
   * @internal
   */
  private stripInternalCacheTags(headers: Headers): void {
    const raw = headers.get("Cache-Tag");
    if (raw === null) return;
    const ns = this.nsToken();
    const kept = raw
      .split(",")
      .map((token) => token.trim())
      .filter(
        (token) =>
          token.length > 0 &&
          token !== `rg:${ns}` &&
          !token.startsWith(`rg:${ns}:`),
      );
    if (kept.length > 0) headers.set("Cache-Tag", kept.join(","));
    else headers.delete("Cache-Tag");
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
    opts?: { critical?: boolean },
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
    } catch (error) {
      // The read-path populate is best-effort: a failed populate just means the
      // next read consults KV. The invalidation WRITE-THROUGH (critical) is not
      // - silently swallowing it would leave this colo's stale marker (often the
      // ABSENT sentinel) authoritative for tagCacheTtl while updateTag reports
      // success. Surface it, and best-effort delete the L1 marker so the next
      // read re-reads KV, which already holds the fresh marker (written before
      // this write-through in invalidateTags).
      if (opts?.critical) {
        reportCacheError(
          error,
          "cache-invalidate",
          "[CFCacheStore] tag marker L1 write-through",
        );
        await reportingAsync(
          async () => {
            const cache = await this.getCache();
            await cache.delete(this.tagMarkerRequest(tag));
          },
          "cache-delete",
          "[CFCacheStore] tag marker L1 evict after failed write-through",
        );
      }
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
   * read-your-own-writes. In purge mode (tagPurge) it then AWAITS the
   * consumer's purge-by-tag call with the entry Cache-Tags — the eviction the
   * per-read marker skip on L1 hits relies on. Finally fires onRevalidateTag
   * with the namespaced lookup Cache-Tags so a consumer purge evicts the
   * cached lookups in other colos promptly (otherwise they converge within
   * tagCacheTtl).
   *
   * Durable-write integrity: the in-memory write-through (memo + L1) for a tag
   * runs ONLY after that tag's KV marker write is confirmed. If any KV write
   * fails (transient error, or an over-512-byte key), this rejects with the
   * failed tags so an awaiting updateTag() surfaces the failure instead of
   * silently reporting success while other requests/colos serve stale data. The
   * eager purge still fires for the whole batch first (it is additive).
   */
  /**
   * Shell tag-generation gate (SegmentCacheStore.isTagsInvalidatedSince): the
   * SAME KV markers used by runtime envelopes also evict immutable build shells
   * and captures whose write races updateTag(). Thin public wrapper over the
   * private envelope check (marker >= since, fail open).
   */
  async isTagsInvalidatedSince(
    tags: string[],
    sinceMs: number,
  ): Promise<boolean> {
    return this.isGloballyInvalidated(tags, sinceMs);
  }

  async invalidateTags(tags: string[]): Promise<void> {
    if (tags.length === 0) return;
    const invalidatedAt = Date.now();
    const ctx = _getRequestContext();
    const memo = ctx ? getTagMarkerMemo(ctx, this) : undefined;

    if (!this.kv && !this.onRevalidateTag && !this.tagPurge) {
      console.warn(
        `[CFCacheStore] invalidateTags had no effect: configure a KV namespace ` +
          `for distributed invalidation, a tagPurge hook for purge-by-tag ` +
          `eviction, or an onRevalidateTag hook.`,
      );
    }

    const failedTags = new Set<string>();
    const errors: unknown[] = [];
    if (this.kv) {
      // Markers written with no expiry (tagInvalidationTtl unset) never expire,
      // so high-cardinality tags accumulate KV keys unboundedly with no reaper.
      // Warn once per namespace at the batch entry point (not per marker write,
      // which would fire once per tag). Kept separate from the floor warning:
      // that path only fires for a positive below-floor value, never the unset
      // default sanitizeTagInvalidationTtl passes through as undefined.
      if (!this.tagInvalidationTtl) {
        this.warnOncePerNamespace(
          warnedNoTagInvalidationTtl,
          `[CFCacheStore] invalidateTags is writing KV markers with no expiry ` +
            `(tagInvalidationTtl is unset): high-cardinality tags accumulate KV ` +
            `keys unboundedly (storage + list-scan cost) with no reaper. Set ` +
            `tagInvalidationTtl above your largest entry TTL+SWR to bound marker ` +
            `growth; setting it too small resurrects invalidated entries.`,
        );
      }
      await Promise.all(
        tags.map(async (tag) => {
          const markerKey = this.tagMarkerKey(tag);
          const markerKeyBytes = kvKeyByteLength(markerKey);
          if (markerKeyBytes > KV_MAX_KEY_BYTES) {
            failedTags.add(tag);
            errors.push(
              new Error(
                `tag "${tag}" produces a ${markerKeyBytes}-byte KV ` +
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

    // Write-through memo + L1 only for tags with a confirmed durable marker, and
    // only when KV is configured. Markers are read exclusively through
    // isGloballyInvalidated(), which short-circuits to "not invalidated" when
    // !this.kv; writing memo/L1 markers without KV would be dead state no read
    // path ever consults — EXCEPT the memo in purge mode: isL1Invalidated()
    // consults it (and only it) on every L1 hit, so a KV-less purge-mode store
    // still writes the memo for same-request read-your-own-writes. The
    // onRevalidateTag purge below still fires regardless (it is additive and
    // external to the marker cascade). The memo write is synchronous
    // (read-your-own-writes); the L1 Cache API writes are independent, so fan
    // them out in parallel rather than awaiting each.
    const lookupMarkerCacheActive = Boolean(this.kv) && this.tagCacheTtl > 0;
    if (this.kv || this.tagPurge) {
      const l1Writes: Promise<void>[] = [];
      for (const tag of tags) {
        if (failedTags.has(tag)) continue;
        memo?.set(tag, invalidatedAt);
        if (lookupMarkerCacheActive) {
          l1Writes.push(
            this.putTagMarkerL1(tag, invalidatedAt, { critical: true }),
          );
        }
      }
      if (l1Writes.length > 0) await Promise.all(l1Writes);
    }

    // Purge mode: evict the tagged L1 entries across every colo via the
    // consumer's purge-by-tag call. AWAITED, and a failure is correctness-
    // bearing (unlike onRevalidateTag): with the per-read marker lookup skipped
    // on L1 hits, a dropped purge leaves L1 serving stale until TTL — so it
    // surfaces through updateTag() like a failed marker write. Fired for the
    // whole batch regardless of marker outcome (purging is additive and
    // idempotent; a retry re-runs both). Lookup Cache-Tags ride along when the
    // L1 marker cache is active (tagCacheTtl > 0 AND kv — without kv no lookup
    // entries are ever written) so a single purge call also converges other
    // colos' cached lookups (no separate onRevalidateTag needed).
    let purgeError: unknown;
    if (this.tagPurge) {
      const purgeTags = tags.flatMap((tag) =>
        lookupMarkerCacheActive
          ? [this.entryPurgeTag(tag), this.lookupPurgeTag(tag)]
          : [this.entryPurgeTag(tag)],
      );
      try {
        await this.tagPurge(purgeTags);
      } catch (error) {
        purgeError = error ?? new Error("tagPurge rejected");
        reportCacheError(
          purgeError,
          "cache-invalidate",
          "[CFCacheStore] tagPurge hook",
        );
      }
    }

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

    if (failedTags.size > 0 || purgeError) {
      const parts: string[] = [];
      if (failedTags.size > 0) {
        parts.push(
          `${failedTags.size}/${tags.length} tag marker write(s) failed: ` +
            `${[...failedTags].join(", ")}`,
        );
      }
      if (purgeError) {
        parts.push(
          `the tagPurge purge-by-tag call failed (tagged L1 entries stay ` +
            `stale until TTL)`,
        );
      }
      const err = new Error(
        `[CFCacheStore] ${parts.join("; ")}. Those tags may still serve ` +
          `stale data across requests/colos; retry the invalidation.`,
      );
      (err as Error & { cause?: unknown }).cause = errors[0] ?? purgeError;
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
  private async kvGetSegment(
    key: string,
    opts?: { suppressRevalidate?: boolean },
  ): Promise<CacheGetResult | null> {
    if (!this.kv) return null;

    try {
      const kvKey = this.toKVKey(key);
      const { value: envelope, timedOut } =
        await this.kvGetOrEvict<KVSegmentEnvelope>(
          kvKey,
          (e) =>
            typeof e.e === "number" && typeof e.s === "number" && e.d != null,
          "kvGetSegment",
        );
      if (timedOut) {
        // Abandoned slow KV read: no envelope, so no promote-to-L1. Distinct
        // from a genuine kv-miss so the degradation is visible on wrangler tail.
        if (this.debug)
          this.emitDebug({ op: "get", key, outcome: "kv-timeout" });
        return null;
      }
      if (!envelope) {
        // Missing key, or a corrupt entry already evicted + reported by
        // kvGetOrEvict. Either way a miss.
        if (this.debug) this.emitDebug({ op: "get", key, outcome: "kv-miss" });
        return null;
      }

      const now = Date.now();

      // Hard-expired — treat as miss
      if (now > envelope.e) {
        if (this.debug) this.emitDebug({ op: "get", key, outcome: "kv-miss" });
        return null;
      }

      // Tag invalidation check (also covers the KV tier, not just L1).
      if (
        await this.isGloballyInvalidated(envelope.d.tags, envelope.d.taggedAt)
      ) {
        if (this.debug)
          this.emitDebug({ op: "get", key, outcome: "tag-invalidated" });
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
      reportCacheError(error, "cache-read", "[CFCacheStore] kvGetSegment");
      if (this.debug) this.emitDebug({ op: "get", key, outcome: "error" });
      return null;
    }
  }

  /**
   * Write segment data to KV.
   *
   * `dataJson` is the already-serialized CachedEntryData body also stored in
   * L1 — embedded as envelope.d without a second JSON.stringify walk.
   * @internal
   */
  private kvSetSegment(
    key: string,
    dataJson: string,
    staleAt: number,
    totalTtl: number,
    swrWindow: number,
  ): void {
    // KV requires expirationTtl >= 60s. Skip write for short-lived entries.
    if (!this.kv || !this.waitUntil || totalTtl < 60) return;

    const kvKey = this.toKVKey(key);

    // Reject an oversized data-segment KV key the same way tag-marker keys are
    // rejected in invalidateTags(). A key over KV_MAX_KEY_BYTES makes kv.put()
    // fail, so the segment silently never lands in L2 (KV) and every cold-colo
    // or TTL-expired read re-renders instead of serving stale. Segment keys can
    // grow with user-controlled inputs (e.g. a route's search params), so report
    // a clear, actionable error and skip the doomed write rather than letting it
    // reject deep inside waitUntil as an opaque cache-write failure.
    const kvKeyBytes = kvKeyByteLength(kvKey);
    if (kvKeyBytes > KV_MAX_KEY_BYTES) {
      reportCacheError(
        new Error(
          `cache segment key produces a ${kvKeyBytes}-byte KV key, over the ` +
            `${KV_MAX_KEY_BYTES}-byte limit; the segment was not persisted to KV (L2). ` +
            `Reduce the cache-key inputs (e.g. large search params on this route).`,
        ),
        "cache-write",
        "[CFCacheStore] kvSetSegment",
      );
      return;
    }

    const expiresAt = staleAt + swrWindow * 1000;
    // Same wire shape as JSON.stringify({ d, s, e }) — dataJson is already
    // valid JSON for CachedEntryData, so embedding it avoids re-walking the tree.
    const envelopeJson = `{"d":${dataJson},"s":${staleAt},"e":${expiresAt}}`;

    this.waitUntil(() =>
      reportingAsync(
        () =>
          this.kv!.put(kvKey, envelopeJson, {
            expirationTtl: totalTtl,
          }),
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
              // Carry the hard-expiry deadline so a promoted entry that later
              // goes stale re-puts with the correct remaining ttl (see set()).
              [CACHE_EXPIRES_AT_HEADER]: String(envelope.e),
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
  private async kvGetItem(
    key: string,
    opts?: { suppressRevalidate?: boolean },
  ): Promise<CacheItemResult | null> {
    if (!this.kv) return null;

    try {
      const kvKey = this.toKVKey(`fn:${key}`);
      const { value: envelope, timedOut } =
        await this.kvGetOrEvict<KVItemEnvelope>(
          kvKey,
          (e) =>
            typeof e.v === "string" &&
            typeof e.e === "number" &&
            typeof e.s === "number",
          "kvGetItem",
        );
      if (timedOut) {
        if (this.debug)
          this.emitDebug({ op: "getItem", key, outcome: "kv-timeout" });
        return null;
      }
      if (!envelope) {
        if (this.debug)
          this.emitDebug({ op: "getItem", key, outcome: "kv-miss" });
        return null;
      }

      const now = Date.now();

      if (now > envelope.e) {
        if (this.debug)
          this.emitDebug({ op: "getItem", key, outcome: "kv-miss" });
        return null;
      }

      // Tag invalidation check (also covers the KV tier, not just L1).
      if (await this.isGloballyInvalidated(envelope.t, envelope.ta)) {
        if (this.debug)
          this.emitDebug({ op: "getItem", key, outcome: "tag-invalidated" });
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
        tags: envelope.t,
      };
    } catch (error) {
      reportCacheError(error, "cache-read", "[CFCacheStore] kvGetItem");
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
              // Carry the hard-expiry deadline; see promoteSegmentToL1 / set().
              [CACHE_EXPIRES_AT_HEADER]: String(envelope.e),
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
      const kvKey = this.toDocKVKey(key);
      // The document path is debug-silent (op is only get/getItem): a KV-read
      // timeout here is bounded for resilience parity (kvGetOrEvict applies the
      // budget) but emits no kv-timeout event, so its absence from the debug
      // stream is expected. A null envelope is a miss -- missing key, a budget
      // timeout, or a corrupt entry already evicted + reported by kvGetOrEvict.
      const { value: envelope } = await this.kvGetOrEvict<KVResponseEnvelope>(
        kvKey,
        (e) =>
          typeof e.b === "string" &&
          typeof e.st === "number" &&
          typeof e.e === "number" &&
          typeof e.s === "number" &&
          // stx is optional but, if present, must be a string (feeds Response).
          (e.stx === undefined || typeof e.stx === "string") &&
          // hd must be an array of [name, value] string tuples; a malformed
          // shape would otherwise throw in `new Headers(hd)`. Validate it here
          // so a faulty envelope is a fail-open MISS, never a thrown read.
          Array.isArray(e.hd) &&
          e.hd.every(
            (entry) =>
              Array.isArray(entry) &&
              entry.length === 2 &&
              typeof entry[0] === "string" &&
              typeof entry[1] === "string",
          ),
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
        // Finding #3 (read side): strip per-client signals a stale envelope may
        // carry. Inside the try so a malformed `hd` evicts (not throws through);
        // mutates `hd` in place so promoteResponseToL1 re-seeds from it too.
        envelope.hd = envelope.hd.filter(
          ([name]) => !isPerClientSignalHeader(name),
        );
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
        this.scheduleKvEvict(kvKey, "kvGetResponse");
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
          // Carry the hard-expiry deadline so the document herd guard's
          // markResponseRevalidating re-put can compute the remaining window
          // (matches promoteSegmentToL1/promoteItemToL1); without it a stale
          // re-put would floor to max-age=1 and churn the KV-promoted twin.
          headers.set(CACHE_EXPIRES_AT_HEADER, String(envelope.e));
          // Re-attach the internal tag headers (envelope.hd is client-facing
          // and intentionally excludes them) so the promoted entry stays
          // invalidatable.
          this.setTagHeaders(headers, envelope.t, envelope.ta);

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
