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
} from "../types.js";
import type { RequestContext } from "../../server/request-context.js";
import { isPerClientSignalHeader } from "../../browser/cookie-name.js";
import {
  resolveTtl,
  resolveSwrWindow,
  computeExpiration,
  DEFAULT_FUNCTION_TTL,
} from "../cache-policy.js";
import { reportCacheError, reportingAsync } from "../cache-error.js";

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
 * Herd-dampening window (ms). On a stale read the store pushes the entry's
 * staleAt forward by this much and re-writes it, so other readers in the same
 * region briefly see it as fresh while one revalidates. Best-effort and
 * non-atomic: `getCache` has no compare-and-set, and storage is regional, so a
 * race can still let two readers both trigger revalidation. Matches the intent of
 * CFCacheStore's MAX_REVALIDATION_INTERVAL without its Cache-API atomicity.
 */
const REVALIDATION_LOCK_MS = 30_000;

/** Family prefixes that keep the three value tiers from colliding in the single
 *  Vercel keyspace. The router's own semantic prefixes (doc:/partial:/use-cache:)
 *  become the suffix; `rg:` namespaces every Rango entry. */
type CacheFamily = "s" | "i" | "r";

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
  /** Tags, preserved so a stale re-stamp keeps them. */
  t?: string[];
}

/** Read-path outcome for the debug sink. */
export type VercelCacheReadOutcome =
  | "miss"
  | "fresh"
  | "stale-revalidate"
  | "expired"
  | "corrupt"
  | "error";

/** Diagnostic event emitted on every read when `debug` is set. */
export interface VercelCacheReadDebugEvent {
  op: "get" | "getItem" | "getResponse";
  key: string;
  outcome: VercelCacheReadOutcome;
  staleAt?: number;
  expiresAt?: number;
  shouldRevalidate?: boolean;
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
   * `waitUntil` from `@vercel/functions`. Used only to run the stale-read
   * re-stamp (herd dampening) off the response path - the router already
   * backgrounds the actual writes. When omitted, the re-stamp runs detached
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

/** Encode binary body bytes to base64 in chunks (avoids call-stack blowups). */
function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decode a base64 body back into bytes. */
function base64ToBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Vercel Runtime Cache-backed segment cache store.
 *
 * Suitable for production deployments on Vercel Functions (Node or Edge). The
 * store is best-effort: every read failure degrades to a miss and every write
 * failure to a no-op (reported, never thrown) - the sole exception is
 * invalidateTags(), which rejects on a failed expireTag so an awaited
 * updateTag() surfaces it (read-your-own-writes honesty).
 *
 * @example
 * ```ts
 * import { getCache, waitUntil } from "@vercel/functions";
 * import { VercelCacheStore } from "@rangojs/router/cache";
 *
 * export const router = createRouter({
 *   cache: () => ({
 *     store: new VercelCacheStore({
 *       cache: getCache({ namespace: import.meta.env.VERCEL_DEPLOYMENT_ID }),
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

  async get(key: string): Promise<CacheGetResult | null> {
    const storeKey = this.toStoreKey(key, "s");
    const started = Date.now();
    let raw: unknown;
    try {
      raw = await this.cache.get(storeKey);
    } catch (error) {
      reportCacheError(error, "cache-read", "[VercelCacheStore] get");
      this.emitDebug({ op: "get", key, outcome: "error" });
      return null;
    }
    const readMs = Date.now() - started;

    if (raw == null) {
      this.emitDebug({ op: "get", key, outcome: "miss", readMs });
      return null;
    }
    const env = this.asSegmentEnvelope(raw);
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
    if (isStale) {
      this.markRevalidating(
        storeKey,
        env,
        env.d.tags,
        "[VercelCacheStore] get",
      );
      this.emitDebug({
        op: "get",
        key,
        outcome: "stale-revalidate",
        shouldRevalidate: true,
        staleAt: env.s,
        expiresAt: env.e,
        readMs,
      });
      return { data: env.d, shouldRevalidate: true };
    }

    this.emitDebug({
      op: "get",
      key,
      outcome: "fresh",
      shouldRevalidate: false,
      staleAt: env.s,
      expiresAt: env.e,
      readMs,
    });
    return { data: env.d, shouldRevalidate: false };
  }

  async set(
    key: string,
    data: CachedEntryData,
    ttl: number,
    swr?: number,
  ): Promise<void> {
    try {
      const swrWindow = resolveSwrWindow(swr, this.defaults);
      const { staleAt, expiresAt } = computeExpiration(ttl, swrWindow);
      const env: VercelSegmentEnvelope = { d: data, s: staleAt, e: expiresAt };
      await this.write(
        this.toStoreKey(key, "s"),
        env,
        ttl + swrWindow,
        data.tags,
        "[VercelCacheStore] set",
      );
    } catch (error) {
      reportCacheError(error, "cache-write", "[VercelCacheStore] set");
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

  async getResponse(
    key: string,
  ): Promise<{ response: Response; shouldRevalidate: boolean } | null> {
    const storeKey = this.toStoreKey(key, "r");
    let raw: unknown;
    try {
      raw = await this.cache.get(storeKey);
    } catch (error) {
      reportCacheError(error, "cache-read", "[VercelCacheStore] getResponse");
      return null;
    }
    if (raw == null) return null;
    const env = this.asResponseEnvelope(raw);
    if (!env) {
      reportCacheError(
        new Error("malformed response envelope"),
        "cache-corrupt",
        "[VercelCacheStore] getResponse",
      );
      void this.safeDelete(storeKey);
      return null;
    }

    const now = Date.now();
    if (now > env.e) {
      void this.safeDelete(storeKey);
      return null;
    }

    const isStale = env.s > 0 && now > env.s;
    if (isStale) {
      this.markRevalidating(
        storeKey,
        env,
        env.t,
        "[VercelCacheStore] getResponse",
      );
    }
    const response = new Response(base64ToBuffer(env.b), {
      status: env.st,
      headers: new Headers(env.hd),
    });
    return { response, shouldRevalidate: isStale };
  }

  async putResponse(
    key: string,
    response: Response,
    ttl: number,
    swr?: number,
    tags?: string[],
  ): Promise<void> {
    try {
      const body = await response.clone().arrayBuffer();
      const headers: [string, string][] = [];
      response.headers.forEach((value, name) => {
        if (isPerClientSignalHeader(name)) return;
        headers.push([name, value]);
      });
      const swrWindow = resolveSwrWindow(swr, this.defaults);
      const { staleAt, expiresAt } = computeExpiration(ttl, swrWindow);
      const env: VercelResponseEnvelope = {
        b: bufferToBase64(body),
        st: response.status,
        hd: headers,
        s: staleAt,
        e: expiresAt,
        t: tags,
      };
      await this.write(
        this.toStoreKey(key, "r"),
        env,
        ttl + swrWindow,
        tags,
        "[VercelCacheStore] putResponse",
      );
    } catch (error) {
      reportCacheError(error, "cache-write", "[VercelCacheStore] putResponse");
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
    const env = this.asItemEnvelope(raw);
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
      this.emitDebug({ op: "getItem", key, outcome: "expired", readMs });
      return null;
    }

    const isStale = env.s > 0 && now > env.s;
    if (isStale) {
      this.markRevalidating(storeKey, env, env.t, "[VercelCacheStore] getItem");
    }
    this.emitDebug({
      op: "getItem",
      key,
      outcome: isStale ? "stale-revalidate" : "fresh",
      shouldRevalidate: isStale,
      staleAt: env.s,
      expiresAt: env.e,
      readMs,
    });
    return {
      value: env.v,
      handles: env.h,
      shouldRevalidate: isStale,
      tags: env.t,
    };
  }

  async setItem(
    key: string,
    value: string,
    options?: CacheItemOptions,
  ): Promise<void> {
    try {
      const ttl = resolveTtl(options?.ttl, this.defaults, DEFAULT_FUNCTION_TTL);
      const swrWindow = resolveSwrWindow(options?.swr, this.defaults);
      const { staleAt, expiresAt } = computeExpiration(ttl, swrWindow);
      const env: VercelItemEnvelope = {
        v: value,
        h: options?.handles,
        s: staleAt,
        e: expiresAt,
        t: options?.tags,
      };
      await this.write(
        this.toStoreKey(key, "i"),
        env,
        ttl + swrWindow,
        options?.tags,
        "[VercelCacheStore] setItem",
      );
    } catch (error) {
      reportCacheError(error, "cache-write", "[VercelCacheStore] setItem");
    }
  }

  // --- Tags ---

  async invalidateTags(tags: string[]): Promise<void> {
    if (!tags || tags.length === 0) return;
    // No per-item cap here: an invalidation must reach every requested tag.
    const safe = this.validateTags(tags, "[VercelCacheStore] invalidateTags");
    if (safe.length === 0) return;
    try {
      await this.cache.expireTag(safe);
    } catch (error) {
      // The one deliberate throw: a failed durable invalidation must reject so an
      // awaited updateTag() surfaces it instead of reporting false success.
      reportCacheError(
        error,
        "cache-invalidate",
        "[VercelCacheStore] invalidateTags",
      );
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  // --- Internals ---

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
  ): Promise<void> {
    if (!this.withinSizeLimit(value, label)) return;
    const safeTags = this.clampTagsForWrite(tags, label);
    const options: { ttl: number; tags?: string[]; name?: string } = {
      ttl: Math.max(1, Math.ceil(totalTtlSeconds)),
    };
    if (safeTags.length > 0) options.tags = safeTags;
    if (this.name) options.name = this.name;
    await this.cache.set(storeKey, value, options);
  }

  /**
   * Stale-read herd dampening: push staleAt forward by REVALIDATION_LOCK_MS
   * (clamped to the hard expiry) and re-write the same envelope under the
   * remaining lifetime, so concurrent same-region readers see it as fresh while
   * one revalidates. Best-effort and non-blocking; never throws.
   */
  private markRevalidating<E extends { s: number; e: number }>(
    storeKey: string,
    env: E,
    tags: string[] | undefined,
    label: string,
  ): void {
    const now = Date.now();
    const remainingSeconds = Math.ceil((env.e - now) / 1000);
    if (remainingSeconds <= 0) return;
    const locked: E = {
      ...env,
      s: Math.min(now + REVALIDATION_LOCK_MS, env.e),
    };
    const task = (): Promise<void> =>
      this.write(storeKey, locked, remainingSeconds, tags, label);
    if (this.waitUntil) {
      this.waitUntil(reportingAsync(task, "cache-write", label));
    } else {
      void reportingAsync(task, "cache-write", label);
    }
  }

  private withinSizeLimit(value: unknown, label: string): boolean {
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
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
    } catch {
      // If the value cannot be measured, allow the write (best-effort).
    }
    return true;
  }

  /** Drop tags Vercel rejects (commas, over-length). Used by invalidateTags. */
  private validateTags(tags: string[], label: string): string[] {
    const encoder = new TextEncoder();
    const out: string[] = [];
    for (const tag of tags) {
      if (tag.includes(",")) {
        reportCacheError(
          new Error(`tag "${tag}" contains a comma; skipped`),
          "cache-invalidate",
          label,
        );
        continue;
      }
      if (encoder.encode(tag).length > VERCEL_MAX_TAG_BYTES) {
        reportCacheError(
          new Error(`tag exceeds ${VERCEL_MAX_TAG_BYTES} bytes; skipped`),
          "cache-invalidate",
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
    const valid = this.validateTags(tags, label);
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
