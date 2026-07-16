/**
 * Vercel Runtime Cache Store
 *
 * A SegmentCacheStore backed by Vercel's Runtime Cache (`getCache()` from
 * `@vercel/functions`). It is the production store analogue to CFCacheStore, but
 * far smaller: Vercel's Runtime Cache already IS a distributed, tag-aware cache
 * (regional storage, global tag-expire within ~300ms), so none of CFCacheStore's
 * L1/L2 tiering, KV tag-marker comparison, marker memoization, or per-tier
 * timeout budgets are needed here - the platform does that work. What this store
 * adds on top of the raw primitive is the parts Vercel does NOT give us:
 *
 *   1. Stale-while-revalidate. `getCache` has no stale-but-serve: a TTL'd entry
 *      simply becomes a miss. We store our own {staleAt, expiresAt} envelope and
 *      set the Vercel ttl to (ttl + swr) so the entry survives its SWR window,
 *      computing staleness ourselves via the shared cache-policy helpers.
 *   2. A single-keyspace family split. `getCache` is one flat keyspace, whereas
 *      the interface has three value families (segments, "use cache" items, full
 *      responses). The memory store keeps three separate Maps; here they must be
 *      namespaced by a prefix or a set() of a response would clobber a segment
 *      cached under the same router key.
 *   3. The platform guardrails: the 2 MB per-item ceiling (oversized writes
 *      silently no-op on Vercel, so we skip + report), the per-item tag cap, and
 *      cross-deploy non-reconciliation (TTL/tag updates are not reconciled across
 *      deployments - bake a build id into `version` or the getCache namespace).
 *
 * Dependency stance: this module imports NOTHING from `@vercel/functions`. The
 * runtime cache handle (and `waitUntil`) are injected through the constructor and
 * typed against the local VercelRuntimeCache shape below, exactly as CFCacheStore
 * takes its `kv`/`ctx` bindings by injection. The consumer passes the real
 * `getCache(...)` result, which satisfies the shape structurally. That keeps the
 * router free of a hard Vercel dependency.
 */

import type {
  SegmentCacheStore,
  CachedEntryData,
  CacheDefaults,
  CacheGetResult,
  CacheItemResult,
  CacheItemOptions,
  ShellCacheEntry,
  ShellSnapshotRecord,
  CacheReadError,
  CacheFreshness,
  CacheResponseResult,
  CacheShellResult,
  CacheWriteAcknowledgement,
} from "../types.js";
import { CACHE_READ_ERROR } from "../types.js";
import type { RequestContext } from "../../server/request-context.js";
import { isPerClientSignalHeader } from "../../browser/cookie-name.js";
import {
  resolveTtl,
  resolveSwrWindow,
  computeExpiration,
  DEFAULT_FUNCTION_TTL,
} from "../cache-policy.js";
import { reportCacheError, reportingAsync } from "../cache-error.js";
import type { CacheErrorCategory } from "../cache-error.js";
// Reuse the CF store's binary-safe base64 helpers. bufferToBase64 caps each
// String.fromCharCode batch at 8192 and uses .apply (never a spread), so a large
// Response/PPR-shell body cannot blow the JS argument-count ceiling (~65k) and
// throw RangeError inside putResponse/putShell - which the outer try/catch would
// swallow as a cache-write degrade, silently never caching the entry. Output is
// byte-identical to a per-byte encoder (chunk size does not affect base64), so
// this is a robustness fix, not a format change. Do NOT reintroduce a local
// spread-based encoder or raise the chunk here; cf-base64.ts is import-pure.
import { bufferToBase64, base64ToBuffer } from "../cf/cf-base64.js";

/**
 * Minimal structural shape of the Vercel Runtime Cache returned by `getCache()`
 * from `@vercel/functions`. Declared locally so @rangojs/router carries no hard
 * dependency on `@vercel/functions`; the real handle satisfies it structurally.
 *
 * @see https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#getcache
 */
export interface VercelRuntimeCache {
  /** Returns the stored value, or a nullish value on miss. Never throws on miss. */
  get(key: string): Promise<unknown>;
  /** Stores a value with optional TTL (seconds), tags, and observability name. */
  set(
    key: string,
    value: unknown,
    options?: { ttl?: number; tags?: string[]; name?: string },
  ): Promise<void>;
  /** Removes a value by key. */
  delete(key: string): Promise<void>;
  /** Expires every entry tagged with any of `tag`. Global, ~300ms propagation. */
  expireTag(tag: string | string[]): Promise<void>;
}

/**
 * Vercel Runtime Cache hard per-item ceiling: 2 MB. Writes above this silently
 * no-op on the platform, so the store measures the serialized envelope and skips
 * (fail-open) entries at or above this size.
 */
export const VERCEL_MAX_ITEM_BYTES: number = 2 * 1024 * 1024;

/**
 * Per-item tag ceiling. Vercel's getCache API reference lists 128 tags per item
 * (https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#getcache).
 * Tags beyond this are dropped with a warning at write time. Does NOT cap
 * invalidateTags() - an invalidation must reach every requested tag.
 */
export const VERCEL_MAX_TAGS_PER_ITEM: number = 128;

/** Max tag length in UTF-8 bytes accepted by Vercel; longer tags are skipped. */
export const VERCEL_MAX_TAG_BYTES: number = 256;

/**
 * URL metacharacters a tag must not contain. The official `@vercel/functions`
 * client interpolates the tag straight into `revalidate?tags=${tag}` with NO
 * URL-encoding (and also sends it in a request header), so a tag carrying one of
 * these is stored intact on write but silently mangled server-side on
 * invalidate: `&` starts a new query param, `?` a query, `#` truncates as a
 * fragment, `%` is read as a (bad) percent-escape, `,` splits the tag list. The
 * entry then never clears while `updateTag()`/`expireTag()` report success -
 * the exact false-success the store's one deliberate throw exists to prevent.
 * Such tags are dropped symmetrically on both the write and invalidate paths.
 */
const VERCEL_UNSAFE_TAG_CHARS = /[,&#%?]/;

/**
 * Herd-dampening window (ms). On a stale read the store pushes the entry's
 * staleAt forward by this much and re-writes it, so other readers in the same
 * region briefly see it as fresh while one revalidates. Best-effort and
 * non-atomic: `getCache` has no compare-and-set, and storage is regional, so a
 * race can still let two readers both trigger revalidation. Matches the intent of
 * CFCacheStore's MAX_REVALIDATION_INTERVAL without its Cache-API atomicity.
 */
const REVALIDATION_LOCK_MS = 30_000;

/** Family prefixes that keep the value tiers from colliding in the single Vercel
 *  keyspace. The router's own semantic prefixes (doc:/partial:/use-cache:) become
 *  the suffix; `rg:` namespaces every Rango entry. `h` is the PPR shell tier. */
type CacheFamily = "s" | "i" | "r" | "h" | "tm";

/**
 * TTL for tag-invalidation marker entries ("tm" family), written by
 * invalidateTags for the build-shell read-through's isTagsInvalidatedSince
 * gate. The platform's expireTag() DELETES tagged entries (no queryable
 * history), so the markers are rango's own record of "tag X was invalidated
 * at T". One year: runtime tagged-shell retention is capped to this lifetime,
 * while buildVersion retires build shells on the next deploy. An expired marker
 * therefore cannot resurrect a runtime shell that outlived its invalidation.
 */
const TAG_MARKER_TTL_SECONDS = 365 * 24 * 60 * 60;

/** Stored envelope for a segment-tree entry (get/set). */
interface VercelSegmentEnvelope {
  /** The cached entry data. */
  d: CachedEntryData;
  /** staleAt (ms since epoch). */
  s: number;
  /** expiresAt (ms since epoch). */
  e: number;
}

/** Stored envelope for a "use cache" function result (getItem/setItem). */
interface VercelItemEnvelope {
  /** RSC-serialized value. */
  v: string;
  /** RSC-encoded handle blob. */
  h?: string;
  /** staleAt (ms since epoch). */
  s: number;
  /** expiresAt (ms since epoch). */
  e: number;
  /** Tags, surfaced on read so a hit still contributes to the document tag set. */
  t?: string[];
}

/** Stored envelope for a full Response (getResponse/putResponse). */
interface VercelResponseEnvelope {
  /** base64-encoded body bytes. */
  b: string;
  /** HTTP status. */
  st: number;
  /** Header entries (per-client signal headers already stripped). */
  hd: [string, string][];
  /** staleAt (ms since epoch). */
  s: number;
  /** expiresAt (ms since epoch). */
  e: number;
  /** Tags, preserved so a background revalidation re-write keeps them. */
  t?: string[];
}

/** Stored envelope for a PPR shell entry (getShell/putShell). */
interface VercelShellEnvelope {
  /** base64-encoded prelude bytes. */
  p: string;
  /** postponed state JSON, or null (DATA variant). */
  po: string | null;
  /** React.version at capture. */
  rv: string;
  /** Build version at capture (ShellCacheEntry.buildVersion). */
  bv?: string;
  /** Capture-generation start time, used by tag marker checks. */
  c: number;
  /** staleAt (ms since epoch). */
  s: number;
  /** expiresAt (ms since epoch). */
  e: number;
  /** Tags, preserved so a background revalidation re-write keeps them. */
  t?: string[];
  /** initialTheme the capture render was built with (resume theme fidelity). */
  i?: string;
  /** Capture data snapshot: recorded cache-store hits/writes for HIT parity. */
  sn?: ShellSnapshotRecord[];
  /**
   * ShellCacheEntry.docKey. Must round-trip: navigation-replay eligibility
   * requires the exact canonical doc segment record named here — dropping the
   * field reads back as "no consumable record" and every partial navigation
   * reports `no-segment-snapshot` after a store round trip.
   */
  dk?: string;
  /**
   * ShellCacheEntry.handlerLiveHoles. Must round-trip: the serve side arms the
   * handler-free fast path on `!entry.handlerLiveHoles`, so dropping the flag
   * here silently fast-pathed handler-live entries after a store round trip —
   * their holes only a handler re-run can fill.
   */
  lh?: boolean;
  /** ShellCacheEntry.transitionWhen; conditional transitions must re-run. */
  tw?: true;
  /** ShellCacheEntry.navigationOnly; its partial-context prelude is not document-safe. */
  no?: true;
}

/** Read-path outcome for the debug sink. */
export type VercelCacheReadOutcome =
  | "miss"
  | "fresh"
  | "stale"
  | "expired"
  | "corrupt"
  | "error";

/** Diagnostic event emitted on every read when `debug` is set. */
export interface VercelCacheReadDebugEvent {
  op: "get" | "getItem" | "getResponse" | "getShell";
  key: string;
  outcome: VercelCacheReadOutcome;
  staleAt?: number;
  expiresAt?: number;
  freshness?: CacheFreshness;
  revalidationClaimed?: boolean;
  /** Wall-clock ms spent in the backing cache.get(). */
  readMs?: number;
}

/** `true` logs each read outcome; a function receives the structured event. */
export type VercelCacheDebug =
  | boolean
  | ((event: VercelCacheReadDebugEvent) => void);

/**
 * Options for VercelCacheStore.
 */
export interface VercelCacheStoreOptions<TEnv = unknown> {
  /**
   * The Vercel Runtime Cache handle - `getCache()` from `@vercel/functions`.
   * Required. Construct it with a build-hash namespace to bust stale-shaped
   * entries across deployments, since Vercel does not reconcile TTL/tags between
   * deploys:
   *
   * ```ts
   * import { getCache } from "@vercel/functions";
   * new VercelCacheStore({ cache: getCache({ namespace: BUILD_ID }) });
   * ```
   */
  cache: VercelRuntimeCache;

  /**
   * `waitUntil` from `@vercel/functions`. Used only to run the stale-read lock
   * write (herd dampening) off the response path - the router already
   * backgrounds the actual writes. When omitted, the lock write runs detached
   * (fire-and-forget) instead.
   */
  waitUntil?: (promise: Promise<unknown>) => void;

  /**
   * Default ttl/swr for cache() boundaries when not explicitly specified.
   */
  defaults?: CacheDefaults;

  /**
   * Custom key generator applied to all cache operations (region/locale/user
   * segmentation). Receives the request context and the default key.
   */
  keyGenerator?: (
    ctx: RequestContext<TEnv>,
    defaultKey: string,
  ) => string | Promise<string>;

  /**
   * Build/version id folded into every stored key as `v/{version}/...`. A second
   * cross-deploy busting layer in addition to (or instead of) the getCache
   * namespace. Changing it invalidates everything this store wrote previously.
   */
  version?: string;

  /**
   * Max serialized entry size in bytes before a write is skipped. Defaults to
   * VERCEL_MAX_ITEM_BYTES (2 MB - the platform's hard cap).
   */
  maxItemBytes?: number;

  /**
   * Human-readable label passed as the Vercel `set({ name })` option for
   * observability in the Vercel dashboard.
   */
  name?: string;

  /**
   * Read diagnostics. `true` logs each read outcome to the console; a function
   * receives the structured VercelCacheReadDebugEvent.
   */
  debug?: VercelCacheDebug;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Vercel Runtime Cache-backed segment cache store.
 *
 * Suitable for production deployments on Vercel Functions (Node runtime). The
 * store is best-effort: every read failure degrades to a miss and every write
 * failure to a failed acknowledgement (reported, never thrown) - the sole exception is
 * invalidateTags(), which rejects when the injected cache's expireTag() rejects
 * so an awaited updateTag() can surface the failure.
 *
 * Read-your-own-writes caveat: this honesty is only as strong as the cache
 * handle. The official `@vercel/functions` cache (`BuildCache.expireTag`)
 * CATCHES backend failures and resolves, so with the official client a failed
 * expireTag is invisible here and an awaited updateTag() can report success that
 * did not happen. Treat tag invalidation on the official Vercel client as
 * best-effort, not a hard read-your-own-writes guarantee. (A custom cache handle
 * that propagates expireTag rejections does get the strict guarantee, which is
 * what the unit suite exercises.)
 *
 * Key hashing / family isolation. The store namespaces its three value tiers as
 * `rg:{s|i|r}:{key}` so segment, `"use cache"`, and response entries occupy
 * disjoint keyspaces. That separation is only as strong as the cache's
 * `keyHashFunction`: `getCache`'s default is djb2, which folds every key to 32
 * bits (8 hex chars), so at a large live-key count a collision can let one
 * entry's body be served for another key (same-family) or be misread as corrupt
 * (cross-family). For deployments with many cached keys, pass a wider hash so
 * the family split is real isolation, e.g. `getCache({ keyHashFunction })` with
 * a sha256-based function.
 *
 * @example
 * ```ts
 * import { getCache, waitUntil } from "@vercel/functions";
 * import { VercelCacheStore } from "@rangojs/router/cache";
 *
 * export const router = createRouter({
 *   cache: () => ({
 *     store: new VercelCacheStore({
 *       // `process.env` (not `import.meta.env`, which needs a VITE_ prefix and
 *       // would be undefined here) so cross-deploy busting via `version` works.
 *       cache: getCache({ namespace: process.env.VERCEL_DEPLOYMENT_ID }),
 *       waitUntil,
 *       defaults: { ttl: 60, swr: 300 },
 *     }),
 *   }),
 * });
 * ```
 */
export class VercelCacheStore<
  TEnv = unknown,
> implements SegmentCacheStore<TEnv> {
  readonly supportsPassiveShellReads: true = true;
  readonly defaults?: CacheDefaults;
  readonly keyGenerator?: (
    ctx: RequestContext<TEnv>,
    defaultKey: string,
  ) => string | Promise<string>;

  private readonly cache: VercelRuntimeCache;
  private readonly waitUntil?: (promise: Promise<unknown>) => void;
  private readonly version?: string;
  private readonly maxItemBytes: number;
  private readonly name?: string;
  private readonly debug?: VercelCacheDebug;

  constructor(options: VercelCacheStoreOptions<TEnv>) {
    if (!options || !options.cache) {
      throw new Error(
        "[VercelCacheStore] requires `cache` (the getCache() handle from @vercel/functions)",
      );
    }
    this.cache = options.cache;
    this.waitUntil = options.waitUntil;
    this.defaults = options.defaults;
    this.keyGenerator = options.keyGenerator;
    this.version = options.version;
    this.maxItemBytes = options.maxItemBytes ?? VERCEL_MAX_ITEM_BYTES;
    this.name = options.name;
    this.debug = options.debug;
  }

  // --- Segment family (get/set/delete) ---

  async get(key: string): Promise<CacheGetResult | null | CacheReadError> {
    const storeKey = this.toStoreKey(key, "s");
    const started = Date.now();
    let raw: unknown;
    try {
      raw = await this.cache.get(storeKey);
    } catch (error) {
      reportCacheError(error, "cache-read", "[VercelCacheStore] get");
      this.emitDebug({ op: "get", key, outcome: "error" });
      // Distinct from a miss so the PPR replay composition renders uncached
      // instead of substituting the seeded doc record (CACHE_READ_ERROR).
      return CACHE_READ_ERROR;
    }
    const readMs = Date.now() - started;

    if (raw == null) {
      this.emitDebug({ op: "get", key, outcome: "miss", readMs });
      return null;
    }
    const env = this.asSegmentEnvelope(this.decodeRaw(raw));
    if (!env) {
      reportCacheError(
        new Error("malformed segment envelope"),
        "cache-corrupt",
        "[VercelCacheStore] get",
      );
      void this.safeDelete(storeKey);
      this.emitDebug({ op: "get", key, outcome: "corrupt", readMs });
      return null;
    }

    const now = Date.now();
    if (now > env.e) {
      void this.safeDelete(storeKey);
      this.emitDebug({
        op: "get",
        key,
        outcome: "expired",
        staleAt: env.s,
        expiresAt: env.e,
        readMs,
      });
      return null;
    }

    const isStale = env.s > 0 && now > env.s;
    const revalidationClaimed = isStale
      ? await this.claimRevalidation(storeKey, env.e, "[VercelCacheStore] get")
      : false;
    const freshness = isStale ? "stale" : "fresh";
    this.emitDebug({
      op: "get",
      key,
      outcome: freshness,
      freshness,
      revalidationClaimed,
      staleAt: env.s,
      expiresAt: env.e,
      readMs,
    });
    return { data: env.d, freshness, revalidationClaimed };
  }

  async set(
    key: string,
    data: CachedEntryData,
    ttl: number,
    swr?: number,
  ): Promise<CacheWriteAcknowledgement> {
    try {
      const swrWindow = resolveSwrWindow(swr, this.defaults);
      const { staleAt, expiresAt } = computeExpiration(ttl, swrWindow);
      // Embed the CLAMPED tags, like putResponse/setItem: the segment family
      // carries its tags inside `d`, and a raw list would resurface dropped
      // tags into recordRequestTags on every hit.
      const safeTags = this.clampTagsForWrite(
        data.tags,
        "[VercelCacheStore] set",
      );
      const d: CachedEntryData = data.tags
        ? { ...data, tags: safeTags.length > 0 ? safeTags : undefined }
        : data;
      const env: VercelSegmentEnvelope = { d, s: staleAt, e: expiresAt };
      return await this.write(
        this.toStoreKey(key, "s"),
        env,
        ttl + swrWindow,
        safeTags,
        "[VercelCacheStore] set",
      );
    } catch (error) {
      reportCacheError(error, "cache-write", "[VercelCacheStore] set");
      return { outcome: "failed" };
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      await this.cache.delete(this.toStoreKey(key, "s"));
      // Vercel's delete returns void; we cannot know whether the key existed.
      // The router uses the boolean only for self-heal eviction, so report success.
      return true;
    } catch (error) {
      reportCacheError(error, "cache-delete", "[VercelCacheStore] delete");
      return false;
    }
  }

  // --- Response family (getResponse/putResponse) ---

  async getResponse(key: string): Promise<CacheResponseResult | null> {
    const storeKey = this.toStoreKey(key, "r");
    const started = Date.now();
    let raw: unknown;
    try {
      raw = await this.cache.get(storeKey);
    } catch (error) {
      reportCacheError(error, "cache-read", "[VercelCacheStore] getResponse");
      this.emitDebug({ op: "getResponse", key, outcome: "error" });
      return null;
    }
    const readMs = Date.now() - started;

    if (raw == null) {
      this.emitDebug({ op: "getResponse", key, outcome: "miss", readMs });
      return null;
    }
    const env = this.asResponseEnvelope(this.decodeRaw(raw));
    if (!env) {
      reportCacheError(
        new Error("malformed response envelope"),
        "cache-corrupt",
        "[VercelCacheStore] getResponse",
      );
      void this.safeDelete(storeKey);
      this.emitDebug({ op: "getResponse", key, outcome: "corrupt", readMs });
      return null;
    }

    const now = Date.now();
    if (now > env.e) {
      void this.safeDelete(storeKey);
      this.emitDebug({
        op: "getResponse",
        key,
        outcome: "expired",
        staleAt: env.s,
        expiresAt: env.e,
        readMs,
      });
      return null;
    }

    // Reconstruct the Response BEFORE claiming revalidation. A corrupt body
    // (e.g. invalid base64 from base64ToBuffer, or bad header entries) would
    // otherwise throw out of getResponse — breaking the fail-open contract — and
    // a stale read would have written a lock for an entry it then evicts. Treat a
    // reconstruction failure as a corrupt entry: report, evict, and miss.
    let response: Response;
    try {
      response = new Response(base64ToBuffer(env.b), {
        status: env.st,
        headers: new Headers(env.hd),
      });
    } catch (error) {
      reportCacheError(
        error,
        "cache-corrupt",
        "[VercelCacheStore] getResponse",
      );
      void this.safeDelete(storeKey);
      this.emitDebug({ op: "getResponse", key, outcome: "corrupt", readMs });
      return null;
    }

    const isStale = env.s > 0 && now > env.s;
    const revalidationClaimed = isStale
      ? await this.claimRevalidation(
          storeKey,
          env.e,
          "[VercelCacheStore] getResponse",
        )
      : false;
    const freshness = isStale ? "stale" : "fresh";
    this.emitDebug({
      op: "getResponse",
      key,
      outcome: freshness,
      freshness,
      revalidationClaimed,
      staleAt: env.s,
      expiresAt: env.e,
      readMs,
    });
    return { response, freshness, revalidationClaimed, tags: env.t };
  }

  async putResponse(
    key: string,
    response: Response,
    ttl: number,
    swr?: number,
    tags?: string[],
  ): Promise<CacheWriteAcknowledgement> {
    try {
      const body = await response.clone().arrayBuffer();
      const headers: [string, string][] = [];
      response.headers.forEach((value, name) => {
        if (isPerClientSignalHeader(name)) return;
        headers.push([name, value]);
      });
      const swrWindow = resolveSwrWindow(swr, this.defaults);
      const { staleAt, expiresAt } = computeExpiration(ttl, swrWindow);
      // Embed the CLAMPED tags in the envelope, not the raw list: tags dropped
      // on write (unsafe/over-cap) would otherwise resurface on a hit and be
      // merged into an upstream document's tag set, letting it claim a tag this
      // entry can't actually be invalidated by. write() re-clamps (idempotent
      // and silent on an already-clean list).
      const safeTags = this.clampTagsForWrite(
        tags,
        "[VercelCacheStore] putResponse",
      );
      const env: VercelResponseEnvelope = {
        b: bufferToBase64(body),
        st: response.status,
        hd: headers,
        s: staleAt,
        e: expiresAt,
        t: safeTags.length > 0 ? safeTags : undefined,
      };
      return await this.write(
        this.toStoreKey(key, "r"),
        env,
        ttl + swrWindow,
        safeTags,
        "[VercelCacheStore] putResponse",
      );
    } catch (error) {
      reportCacheError(error, "cache-write", "[VercelCacheStore] putResponse");
      return { outcome: "failed" };
    }
  }

  // --- Item family ("use cache" - getItem/setItem) ---

  async getItem(key: string): Promise<CacheItemResult | null> {
    const storeKey = this.toStoreKey(key, "i");
    const started = Date.now();
    let raw: unknown;
    try {
      raw = await this.cache.get(storeKey);
    } catch (error) {
      reportCacheError(error, "cache-read", "[VercelCacheStore] getItem");
      this.emitDebug({ op: "getItem", key, outcome: "error" });
      return null;
    }
    const readMs = Date.now() - started;

    if (raw == null) {
      this.emitDebug({ op: "getItem", key, outcome: "miss", readMs });
      return null;
    }
    const env = this.asItemEnvelope(this.decodeRaw(raw));
    if (!env) {
      reportCacheError(
        new Error("malformed item envelope"),
        "cache-corrupt",
        "[VercelCacheStore] getItem",
      );
      void this.safeDelete(storeKey);
      this.emitDebug({ op: "getItem", key, outcome: "corrupt", readMs });
      return null;
    }

    const now = Date.now();
    if (now > env.e) {
      void this.safeDelete(storeKey);
      this.emitDebug({
        op: "getItem",
        key,
        outcome: "expired",
        staleAt: env.s,
        expiresAt: env.e,
        readMs,
      });
      return null;
    }

    const isStale = env.s > 0 && now > env.s;
    const revalidationClaimed = isStale
      ? await this.claimRevalidation(
          storeKey,
          env.e,
          "[VercelCacheStore] getItem",
        )
      : false;
    const freshness = isStale ? "stale" : "fresh";
    this.emitDebug({
      op: "getItem",
      key,
      outcome: freshness,
      freshness,
      revalidationClaimed,
      staleAt: env.s,
      expiresAt: env.e,
      readMs,
    });
    return {
      value: env.v,
      handles: env.h,
      freshness,
      revalidationClaimed,
      tags: env.t,
    };
  }

  async setItem(
    key: string,
    value: string,
    options?: CacheItemOptions,
  ): Promise<CacheWriteAcknowledgement> {
    try {
      const ttl = resolveTtl(options?.ttl, this.defaults, DEFAULT_FUNCTION_TTL);
      const swrWindow = resolveSwrWindow(options?.swr, this.defaults);
      const { staleAt, expiresAt } = computeExpiration(ttl, swrWindow);
      // Store the clamped tags (see putResponse) so dropped tags don't resurface
      // on a hit; write() re-clamps idempotently.
      const safeTags = this.clampTagsForWrite(
        options?.tags,
        "[VercelCacheStore] setItem",
      );
      const env: VercelItemEnvelope = {
        v: value,
        h: options?.handles,
        s: staleAt,
        e: expiresAt,
        t: safeTags.length > 0 ? safeTags : undefined,
      };
      return await this.write(
        this.toStoreKey(key, "i"),
        env,
        ttl + swrWindow,
        safeTags,
        "[VercelCacheStore] setItem",
      );
    } catch (error) {
      reportCacheError(error, "cache-write", "[VercelCacheStore] setItem");
      return { outcome: "failed" };
    }
  }

  // --- Shell family (PPR shell resume - getShell/putShell) ---

  async getShell(
    key: string,
    options?: { claimRevalidation?: boolean },
  ): Promise<CacheShellResult | null> {
    const storeKey = this.toStoreKey(key, "h");
    const started = Date.now();
    let raw: unknown;
    try {
      raw = await this.cache.get(storeKey);
    } catch (error) {
      reportCacheError(error, "cache-read", "[VercelCacheStore] getShell");
      this.emitDebug({ op: "getShell", key, outcome: "error" });
      return null;
    }
    const readMs = Date.now() - started;

    if (raw == null) {
      this.emitDebug({ op: "getShell", key, outcome: "miss", readMs });
      return null;
    }
    const env = this.asShellEnvelope(this.decodeRaw(raw));
    if (!env) {
      reportCacheError(
        new Error("malformed shell envelope"),
        "cache-corrupt",
        "[VercelCacheStore] getShell",
      );
      void this.safeDelete(storeKey);
      this.emitDebug({ op: "getShell", key, outcome: "corrupt", readMs });
      return null;
    }

    const now = Date.now();
    if (now > env.e) {
      void this.safeDelete(storeKey);
      this.emitDebug({
        op: "getShell",
        key,
        outcome: "expired",
        staleAt: env.s,
        expiresAt: env.e,
        readMs,
      });
      return null;
    }

    if (
      env.t &&
      env.t.length > 0 &&
      (await this.isTagsInvalidatedSince(env.t, env.c))
    ) {
      void this.safeDelete(storeKey);
      this.emitDebug({ op: "getShell", key, outcome: "miss", readMs });
      return null;
    }

    const isStale = env.s > 0 && now > env.s;
    const revalidationClaimed =
      isStale && options?.claimRevalidation !== false
        ? await this.claimRevalidation(
            storeKey,
            env.e,
            "[VercelCacheStore] getShell",
          )
        : false;
    const freshness = isStale ? "stale" : "fresh";
    this.emitDebug({
      op: "getShell",
      key,
      outcome: freshness,
      freshness,
      revalidationClaimed,
      staleAt: env.s,
      expiresAt: env.e,
      readMs,
    });
    return {
      entry: {
        prelude: env.p,
        postponed: env.po,
        reactVersion: env.rv,
        buildVersion: env.bv,
        initialTheme: env.i,
        snapshot: env.sn,
        docKey: env.dk,
        handlerLiveHoles: env.lh,
        transitionWhen: env.tw,
        navigationOnly: env.no,
        createdAt: env.c,
      },
      freshness,
      revalidationClaimed,
      tags: env.t,
    };
  }

  async putShell(
    key: string,
    entry: ShellCacheEntry,
    ttlSeconds?: number,
    swrSeconds?: number,
    tags?: string[],
  ): Promise<CacheWriteAcknowledgement> {
    try {
      const ttl = resolveTtl(ttlSeconds, this.defaults, DEFAULT_FUNCTION_TTL);
      const swrWindow = resolveSwrWindow(swrSeconds, this.defaults);
      const totalTtl = ttl + swrWindow;
      const now = Date.now();
      const { staleAt, expiresAt } = computeExpiration(ttl, swrWindow);
      // Store the CLAMPED tags (see putResponse/setItem) so dropped tags don't
      // resurface on a hit; write() re-clamps idempotently.
      const safeTags = this.clampTagsForWrite(
        tags,
        "[VercelCacheStore] putShell",
      );
      const storeKey = this.toStoreKey(key, "h");
      if (
        safeTags.length > 0 &&
        (await this.isTagsInvalidatedSince(safeTags, entry.createdAt))
      ) {
        return { outcome: "skipped", reason: "invalidated-generation" };
      }
      const retentionTtl =
        safeTags.length > 0
          ? Math.min(totalTtl, TAG_MARKER_TTL_SECONDS)
          : totalTtl;
      const env: VercelShellEnvelope = {
        p: entry.prelude,
        po: entry.postponed,
        rv: entry.reactVersion,
        bv: entry.buildVersion,
        c: entry.createdAt,
        s: staleAt,
        e: Math.min(expiresAt, now + retentionTtl * 1000),
        t: safeTags.length > 0 ? safeTags : undefined,
        i: entry.initialTheme,
        sn: entry.snapshot,
        dk: entry.docKey,
        lh: entry.handlerLiveHoles,
        tw: entry.transitionWhen,
        no: entry.navigationOnly,
      };
      // write() enforces the 2 MB per-item ceiling (withinSizeLimit): an
      // oversized shell prelude is reported and skipped (fail-open to a full
      // render), never silently no-op'd on the platform.
      return await this.write(
        storeKey,
        env,
        retentionTtl,
        safeTags,
        "[VercelCacheStore] putShell",
      );
    } catch (error) {
      reportCacheError(error, "cache-write", "[VercelCacheStore] putShell");
      return { outcome: "failed" };
    }
  }

  // --- Tags ---

  /**
   * Shell tag-generation gate (SegmentCacheStore.isTagsInvalidatedSince).
   * expireTag() keeps no queryable history, so invalidateTags() writes "tm"
   * markers for runtime capture races and immutable build shells. Marker >=
   * generation start wins; read errors fail open like the CF marker check.
   */
  async isTagsInvalidatedSince(
    tags: string[],
    sinceMs: number,
  ): Promise<boolean> {
    try {
      const markers = await Promise.all(
        tags.map((tag) => this.cache.get(this.toStoreKey(tag, "tm"))),
      );
      for (const raw of markers) {
        if (raw == null) continue;
        const decoded = this.decodeRaw(raw) as { at?: unknown } | null;
        const at =
          decoded && typeof decoded.at === "number" ? decoded.at : null;
        if (at !== null && at >= sinceMs) return true;
      }
      return false;
    } catch (error) {
      reportCacheError(
        error,
        "cache-read",
        "[VercelCacheStore] tag invalidation check",
      );
      return false;
    }
  }

  async invalidateTags(tags: string[]): Promise<void> {
    if (!tags || tags.length === 0) return;
    // No per-item cap here: an invalidation must reach every requested tag.
    const safe = this.validateTags(
      tags,
      "[VercelCacheStore] invalidateTags",
      "cache-invalidate",
    );
    if (safe.length === 0) return;
    // Marker writes FIRST, and strict: isTagsInvalidatedSince() is how an
    // updateTag() reaches a build-time shell entry (expireTag cannot delete
    // what lives in the build manifest), so a failed marker write must reject
    // like a failed expireTag — silently resolving would report success while
    // the baked shell keeps serving.
    await Promise.all(
      safe.map((tag) =>
        this.cache.set(
          this.toStoreKey(tag, "tm"),
          JSON.stringify({ at: Date.now() }),
          { ttl: TAG_MARKER_TTL_SECONDS },
        ),
      ),
    );
    try {
      await this.cache.expireTag(safe);
    } catch (error) {
      // The one deliberate throw: a failed durable invalidation must reject so an
      // awaited updateTag() surfaces it instead of reporting false success.
      // NOTE: this only fires if the injected cache's expireTag() actually
      // rejects. The official @vercel/functions cache catches backend failures
      // and resolves, so on that client a failure is invisible and this throw
      // never fires (tag invalidation is best-effort there). See the class doc.
      reportCacheError(
        error,
        "cache-invalidate",
        "[VercelCacheStore] invalidateTags",
      );
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  // --- Internals ---

  // The `rg:{family}:` prefix keeps the three value tiers in disjoint
  // keyspaces, but the isolation is only as strong as the cache's
  // keyHashFunction: djb2 (getCache's default) folds this to 32 bits, so at a
  // large live-key count a same-family collision can serve the wrong body and a
  // cross-family one reads as corrupt. See the class doc for passing a wider
  // hash (sha256) when many keys are live.
  private toStoreKey(key: string, family: CacheFamily): string {
    const versionPrefix = this.version ? `v/${this.version}/` : "";
    return `${versionPrefix}rg:${family}:${key}`;
  }

  private async write(
    storeKey: string,
    value: unknown,
    totalTtlSeconds: number,
    tags: string[] | undefined,
    label: string,
  ): Promise<CacheWriteAcknowledgement> {
    // Serialize the envelope exactly ONCE: the same string measures the entry
    // against the size cap AND is what we hand the platform. The Vercel client
    // JSON-serializes whatever value it is given, so passing the raw object here
    // would walk and stringify the (potentially large) envelope a SECOND time.
    // Entries written this way are JSON strings; the read path (decodeRaw)
    // parses them back, and still accepts the legacy object shape written before
    // this change.
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      // Unserializable value: fall back to letting the platform serialize it
      // (best-effort — matches the prior "cannot measure -> allow the write").
      serialized = undefined;
    }
    if (serialized !== undefined && !this.withinSizeLimit(serialized, label)) {
      return { outcome: "skipped", reason: "size-limit" };
    }
    const safeTags = this.clampTagsForWrite(tags, label);
    const options: { ttl: number; tags?: string[]; name?: string } = {
      ttl: Math.max(1, Math.ceil(totalTtlSeconds)),
    };
    if (safeTags.length > 0) options.tags = safeTags;
    if (this.name) options.name = this.name;
    await this.cache.set(storeKey, serialized ?? value, options);
    return { outcome: "stored" };
  }

  /**
   * Normalize a value read back from the cache. Entries written by this store
   * are pre-serialized JSON strings (see write()); legacy entries (written
   * before that change, or by a client that deserializes for us) come back as
   * objects. Parse strings, pass objects through, and treat a non-JSON string
   * as corrupt (returns undefined, so the caller reports + evicts).
   */
  private decodeRaw(raw: unknown): unknown {
    if (typeof raw !== "string") return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  /**
   * Stale-read herd dampening via a tiny companion lock key. On a stale read,
   * check `{storeKey}:lock`; if absent, claim it (write a short-TTL marker) and
   * return true so THIS reader triggers revalidation. If present, another
   * same-region reader already claimed it, so return false and serve the stale
   * entry as fresh without piling on. Best-effort and non-blocking; never throws.
   *
   * Only the STALE path pays the extra lock read; the fresh-hit path takes no
   * lock round trip. Unlike the prior whole-envelope re-stamp, a stale read now
   * writes only the tiny lock, never the (potentially large) payload.
   *
   * Non-atomic (getCache has no compare-and-set): two readers can both find no
   * lock and both revalidate. The window is REVALIDATION_LOCK_MS wide, after
   * which the lock expires and the entry is re-claimed (or a fresh write has
   * superseded it). A read-compare would not close the race without CAS.
   */
  private async claimRevalidation(
    storeKey: string,
    expiresAt: number,
    label: string,
  ): Promise<boolean> {
    const lockKey = `${storeKey}:lock`;
    let lock: unknown;
    try {
      lock = await this.cache.get(lockKey);
    } catch {
      // A lock-read failure must not break the read path: treat as unlocked.
      lock = null;
    }
    if (lock != null) return false;

    const remainingSeconds = Math.ceil((expiresAt - Date.now()) / 1000);
    const lockTtl = Math.max(
      1,
      Math.min(Math.ceil(REVALIDATION_LOCK_MS / 1000), remainingSeconds),
    );
    const task = (): Promise<void> =>
      this.cache.set(lockKey, 1, { ttl: lockTtl });
    if (this.waitUntil) {
      this.waitUntil(reportingAsync(task, "cache-write", label));
    } else {
      void reportingAsync(task, "cache-write", label);
    }
    return true;
  }

  /** Measure a pre-serialized entry against the per-item size cap (see write). */
  private withinSizeLimit(serialized: string, label: string): boolean {
    const bytes = new TextEncoder().encode(serialized).length;
    if (bytes >= this.maxItemBytes) {
      reportCacheError(
        new Error(
          `entry is ${bytes}B, at/above the ${this.maxItemBytes}B cap; not cached`,
        ),
        "cache-write",
        label,
      );
      return false;
    }
    return true;
  }

  /**
   * Drop tags Vercel cannot round-trip: over-length tags, and tags carrying a
   * URL metacharacter the `@vercel/functions` client does not encode (see
   * VERCEL_UNSAFE_TAG_CHARS). Runs on BOTH paths - the write path
   * (clampTagsForWrite) and invalidateTags - so a tag that would silently fail
   * invalidation is never stored in the first place. `category` reports the
   * drop under the caller's real operation (write vs invalidate).
   */
  private validateTags(
    tags: string[],
    label: string,
    category: CacheErrorCategory,
  ): string[] {
    const encoder = new TextEncoder();
    const out: string[] = [];
    for (const tag of tags) {
      const unsafe = VERCEL_UNSAFE_TAG_CHARS.exec(tag);
      if (unsafe) {
        reportCacheError(
          new Error(
            `tag "${tag}" contains an unencodable URL character "${unsafe[0]}"; ` +
              `skipped (it would not round-trip through Vercel tag invalidation)`,
          ),
          category,
          label,
        );
        continue;
      }
      if (encoder.encode(tag).length > VERCEL_MAX_TAG_BYTES) {
        reportCacheError(
          new Error(`tag exceeds ${VERCEL_MAX_TAG_BYTES} bytes; skipped`),
          category,
          label,
        );
        continue;
      }
      out.push(tag);
    }
    return out;
  }

  /** validateTags + the per-item tag cap. Used on the write path. */
  private clampTagsForWrite(
    tags: string[] | undefined,
    label: string,
  ): string[] {
    if (!tags || tags.length === 0) return [];
    const valid = this.validateTags(tags, label, "cache-write");
    if (valid.length > VERCEL_MAX_TAGS_PER_ITEM) {
      reportCacheError(
        new Error(
          `entry has ${valid.length} tags, over the ${VERCEL_MAX_TAGS_PER_ITEM}-tag cap; ` +
            `keeping the first ${VERCEL_MAX_TAGS_PER_ITEM}`,
        ),
        "cache-write",
        label,
      );
      return valid.slice(0, VERCEL_MAX_TAGS_PER_ITEM);
    }
    return valid;
  }

  private async safeDelete(storeKey: string): Promise<void> {
    try {
      await this.cache.delete(storeKey);
    } catch (error) {
      reportCacheError(error, "cache-delete", "[VercelCacheStore] evict");
    }
  }

  private emitDebug(event: VercelCacheReadDebugEvent): void {
    const sink = this.debug;
    if (!sink) return;
    try {
      if (typeof sink === "function") sink(event);
      else console.log("[VercelCacheStore]", event);
    } catch {
      // The debug sink must never break the cache path.
    }
  }

  private asSegmentEnvelope(raw: unknown): VercelSegmentEnvelope | null {
    if (!isRecord(raw)) return null;
    const { d, s, e } = raw;
    if (
      !isRecord(d) ||
      !Array.isArray((d as Record<string, unknown>).segments)
    ) {
      return null;
    }
    if (typeof s !== "number" || typeof e !== "number") return null;
    return { d: d as unknown as CachedEntryData, s, e };
  }

  private asItemEnvelope(raw: unknown): VercelItemEnvelope | null {
    if (!isRecord(raw)) return null;
    const { v, h, s, e, t } = raw;
    if (typeof v !== "string") return null;
    if (typeof s !== "number" || typeof e !== "number") return null;
    return {
      v,
      h: typeof h === "string" ? h : undefined,
      s,
      e,
      t: Array.isArray(t) ? (t as string[]) : undefined,
    };
  }

  private asShellEnvelope(raw: unknown): VercelShellEnvelope | null {
    if (!isRecord(raw)) return null;
    const { p, po, rv, bv, c, s, e, t, i, sn, dk, lh, tw, no } = raw;
    if (typeof p !== "string" || typeof rv !== "string") return null;
    if (po !== null && typeof po !== "string") return null;
    if (typeof c !== "number") return null;
    if (typeof s !== "number" || typeof e !== "number") return null;
    return {
      p,
      po: po as string | null,
      rv,
      bv: typeof bv === "string" ? bv : undefined,
      c,
      s,
      e,
      t: Array.isArray(t) ? (t as string[]) : undefined,
      i: typeof i === "string" ? i : undefined,
      sn: Array.isArray(sn) ? (sn as ShellSnapshotRecord[]) : undefined,
      dk: typeof dk === "string" ? dk : undefined,
      lh: lh === true ? true : undefined,
      tw: tw === true ? true : undefined,
      no: no === true ? true : undefined,
    };
  }

  private asResponseEnvelope(raw: unknown): VercelResponseEnvelope | null {
    if (!isRecord(raw)) return null;
    const { b, st, hd, s, e, t } = raw;
    if (typeof b !== "string" || typeof st !== "number") return null;
    if (!Array.isArray(hd)) return null;
    if (typeof s !== "number" || typeof e !== "number") return null;
    return {
      b,
      st,
      hd: hd as [string, string][],
      s,
      e,
      t: Array.isArray(t) ? (t as string[]) : undefined,
    };
  }
}
