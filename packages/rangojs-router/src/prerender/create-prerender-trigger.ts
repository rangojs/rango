/**
 * `router.prerender()` trigger factory.
 *
 * Builds the `router.prerender` binder: `(runtime) => runner`, the runner being
 * the per-target callable (plus `.many` / `.markStale`) from router-supplied
 * deps. Pure and testable: all router internals (reverse, match, the producer,
 * the request handler) arrive as injected functions, so this module has no RSC
 * imports and can be unit-tested with fakes.
 *
 * One verb, dispatched by route after the match:
 * - A `Prerender(..., { onDemand })` route takes the requestless render into
 *   the prerender store (docs/design/ondemand-prerender.md), then, when the
 *   app cache store is shared and an origin resolves, a warm request that
 *   rebuilds the runtime caches on top of the new entry.
 * - Every other route is warmed: a cookie-free GET through the router's own
 *   handler in which every runtime cache read misses and every write replaces
 *   the entry (docs/design/prerender-every-route.md).
 *
 * Contract highlights:
 * - Requestless: the producer render never inherits the caller's request state.
 * - A refresh always renders and replaces; `onlyIfStale` is the cron-sweep
 *   opt-in and the only path that returns `already-fresh`.
 * - A failed render/store keeps the previous entry (replace-on-success).
 * - An on-demand target is path-only (its key carries no search); a warm
 *   target keeps its search params, which cache keys carry.
 * - A warm writes only to a store shared beyond the place the call runs.
 */

import type { SerializedSegmentData } from "../cache/types.js";
import { isReservedSearchParam } from "../cache/cache-key-utils.js";
import { resolveWarmStoreScope } from "../cache/store-scope.js";
import type { HandlerCacheConfig } from "../rsc/types.js";
import type { ExecutionContext } from "../types/request-scope.js";
import { createCollectingExecutionContext } from "../cache/background-task.js";
import { composeWarmResult, runWarmRequest } from "./warm.js";
import { hashParams } from "./param-hash.js";
import { isPrerenderPersonalizationError } from "./producer-guard.js";
import { normalizeTagList } from "../cache/cache-policy.js";
import {
  composeStoredEntry,
  isStoredEntryStale,
  readVerifiedStoredEntry,
  serializePrerenderKey,
  type PrerenderKey,
} from "./writable-store.js";
import type {
  OnDemandRouteConfig,
  PrerenderConfig,
  PrerenderFn,
  PrerenderManyOptions,
  PrerenderResult,
  PrerenderRunner,
  PrerenderRunOptions,
  PrerenderRuntime,
  PrerenderTarget,
} from "./on-demand.js";

/** Route metadata the trigger needs, resolved from a pathname by the router. */
export interface PrerenderMatchInfo {
  routeName: string;
  params: Record<string, string>;
  /** True when the route opted into on-demand (Prerender(..., { onDemand })). */
  isOnDemand: boolean;
  /** True when the route is wrapped in Passthrough(). */
  isPassthrough: boolean;
}

/**
 * Raw producer output (matchForPrerender's main-variant shape). `onDemandConfig`
 * is the route's `onDemand: { ttl, tags }` object (the `tags` callback can't
 * ride the serialized trie), read from the loaded route entry during production.
 */
export interface ProducerOutput {
  segments: SerializedSegmentData[];
  handles: string;
  routeName: string;
  params: Record<string, string>;
  passthrough?: true;
  onDemandConfig?: OnDemandRouteConfig;
}

export interface PrerenderTriggerDeps<TEnv = any> {
  routerId: string;
  /**
   * The key version: the router's data version (resolvePrerenderVersion),
   * resolved per refresh (once per `.many()` batch), as the request handler
   * resolves it per request.
   */
  resolveVersion: () => string;
  /** True when running under Vite dev (drives the producer context's `dev`). */
  isDev: () => boolean;
  /**
   * True under the Vite dev server (isViteDevServer): the one place the
   * memory store counts as shared, and so where the not-shared warning fires.
   */
  isViteDevServer: () => boolean;
  /** Load the per-router manifest/trie before matching, as router.fetch does. */
  ensureManifest: () => Promise<void>;
  /** Resolve the env-scoped prerender config (factory or object); undefined when unconfigured. */
  resolveConfig: (
    env: TEnv,
    ctx: ExecutionContext | undefined,
  ) => PrerenderConfig<TEnv> | undefined;
  /** Reverse an object target to a pathname; undefined when the route name is unknown. */
  reverse: (
    route: string,
    params: Record<string, string>,
  ) => string | undefined;
  /** Match a pathname to route metadata; null when nothing matches. */
  matchRoute: (
    pathname: string,
  ) => PrerenderMatchInfo | null | Promise<PrerenderMatchInfo | null>;
  /** Run the requestless producer (matchForPrerender with onDemand). May throw. */
  runProducer: (input: {
    pathname: string;
    isPassthrough: boolean;
    env: TEnv;
    dev: boolean;
  }) => Promise<ProducerOutput | null>;
  /**
   * Resolve `createRouter({ cache })` (factory or object) for a warm;
   * undefined when the router has none. May throw, like the prerender factory.
   */
  resolveCacheConfig: (
    env: TEnv,
    ctx: ExecutionContext,
  ) => HandlerCacheConfig | undefined;
  /** The router's own request handler (`router.fetch`): where a warm is dispatched. */
  fetch: (
    request: Request,
    input: { env: TEnv; ctx: ExecutionContext },
  ) => Promise<Response>;
  /** The origin of the request the runner is called from, when there is one. */
  ambientOrigin: () => string | undefined;
}

/** Thrown by the trigger when `throwOnError: true` and the operation did not succeed. */
export class PrerenderError extends Error {
  readonly result: Extract<PrerenderResult, { ok: false }>;
  constructor(result: Extract<PrerenderResult, { ok: false }>) {
    super(
      `router.prerender("${result.target}") failed: ${result.status}` +
        (result.error instanceof Error ? ` — ${result.error.message}` : ""),
    );
    this.name = "PrerenderError";
    this.result = result;
    if (result.error !== undefined) this.cause = result.error;
  }
}

interface ResolvedTarget {
  /** Path with no search/hash, ready to match. */
  pathname?: string;
  /** Display form used in the result's `target` field. */
  display: string;
  /** Set when the target does not parse as an http(s) URL or a path. */
  unsupported?: boolean;
  /** The target's own origin: a full-URL string or a URL. */
  origin?: string;
  /** `?`-prefixed search, or "". */
  search: string;
  /** The target carries a hash, or a search param the router reserves. */
  hashOrReserved: boolean;
}

/** Stands in for the origin while a path target is parsed; never requested. */
const PATH_BASE = "http://prerender.local";

function resolveTarget<TRoutes>(
  target: PrerenderTarget<TRoutes>,
  reverse: PrerenderTriggerDeps["reverse"],
): ResolvedTarget {
  if (typeof target === "string") {
    return fromUrlLike(target, target);
  }
  if (target instanceof URL) {
    return fromUrlLike(target.href, target.pathname);
  }
  // Object target { route, params? }
  const route = (target as { route: string }).route;
  const params = ((target as { params?: Record<string, string> }).params ??
    {}) as Record<string, string>;
  const pathname = reverse(route, params);
  if (pathname === undefined) {
    // Unknown route name — surfaced as no-match downstream.
    return { display: route, search: "", hashOrReserved: false };
  }
  return fromUrlLike(pathname, pathname);
}

function fromUrlLike(raw: string, display: string): ResolvedTarget {
  let url: URL;
  try {
    // A relative path resolves against the stand-in base; a full URL keeps
    // its own origin, which a warm requests (cache keys carry the host).
    url = new URL(raw, PATH_BASE);
  } catch {
    return { display, unsupported: true, search: "", hashOrReserved: false };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { display, unsupported: true, search: "", hashOrReserved: false };
  }
  // The params that switch the handler's mode (`_rsc*`, `__no_cache`) are not
  // a page a visitor requests.
  const reserved = [...url.searchParams.keys()].some(isReservedSearchParam);
  return {
    pathname: url.pathname,
    display: url.pathname,
    ...(url.origin !== PATH_BASE ? { origin: url.origin } : {}),
    search: url.search,
    hashOrReserved: url.hash !== "" || reserved,
  };
}

/**
 * Create the `router.prerender` callable. See {@link PrerenderTriggerDeps}.
 */
export function createPrerenderTrigger<TEnv = any, TRoutes = {}>(
  deps: PrerenderTriggerDeps<TEnv>,
): PrerenderFn<TEnv, TRoutes> {
  async function refresh(
    target: PrerenderTarget<TRoutes>,
    runtime: PrerenderRuntime<TEnv>,
    options: PrerenderRunOptions = {},
    version: string = deps.resolveVersion(),
  ): Promise<PrerenderResult> {
    const result = await run(target, runtime, options, version);
    if (!result.ok && options.throwOnError) throw new PrerenderError(result);
    return result;
  }

  async function run(
    target: PrerenderTarget<TRoutes>,
    runtime: PrerenderRuntime<TEnv>,
    options: PrerenderRunOptions,
    version: string,
  ): Promise<PrerenderResult> {
    const resolved = resolveTarget(target, deps.reverse);
    const display = resolved.display;

    if (resolved.unsupported) {
      return {
        ok: false,
        status: "skipped-unsupported-target",
        target: display,
      };
    }
    if (resolved.pathname === undefined) {
      return { ok: false, status: "no-match", target: display };
    }

    await deps.ensureManifest();

    const match = await deps.matchRoute(resolved.pathname);
    if (!match) {
      return { ok: false, status: "no-match", target: display };
    }
    if (resolved.hashOrReserved) {
      return {
        ok: false,
        path: match.isOnDemand ? "on-demand" : "warm",
        status: "skipped-unsupported-target",
        target: display,
        routeName: match.routeName,
      };
    }
    if (!match.isOnDemand) {
      return warm(
        resolved,
        match,
        runtime,
        options.onlyIfStale ? "fill" : "replace",
      );
    }

    if (resolved.search) {
      // An on-demand key is route + params: a search would silently persist
      // under the base key.
      return {
        ok: false,
        path: "on-demand",
        status: "skipped-unsupported-target",
        target: display,
        routeName: match.routeName,
      };
    }
    const result = await renderOnDemand(
      resolved.pathname,
      display,
      match,
      runtime,
      options,
      version,
    );
    // Then the request handler, on top of the entry just stored: the route's
    // loaders' own cache() and the document cache are rebuilt on it. A
    // Passthrough param the producer declined is served by the live handler,
    // whose caches are warmed the same way. Quiet: the refresh is complete
    // without it.
    if (
      result.status === "rendered" ||
      result.status === "skipped-passthrough"
    ) {
      const warmed = await warm(resolved, match, runtime, "replace", true);
      if (warmed.caches) return { ...result, caches: warmed.caches };
    }
    return result;
  }

  let warnedNotShared = false;

  /**
   * Warm one matched route: a GET of the URL a visitor requests, through the
   * router's own handler. `followUp` is the warm after an on-demand render:
   * its refusals are not worth a warning, the render already did its job.
   */
  async function warm(
    resolved: ResolvedTarget,
    match: PrerenderMatchInfo,
    runtime: PrerenderRuntime<TEnv>,
    mode: "replace" | "fill",
    followUp = false,
  ): Promise<PrerenderResult> {
    const refused = (
      status: Extract<PrerenderResult, { ok: false }>["status"],
      target: string = resolved.display,
      error?: unknown,
    ): PrerenderResult => ({
      ok: false,
      path: "warm",
      status,
      target,
      routeName: match.routeName,
      ...(error !== undefined ? { error } : {}),
    });

    // Cache keys carry the host, so the warm requests the host visitors use:
    // the target's own, the binding's, else the calling request's.
    let origin: string | undefined;
    try {
      origin =
        resolved.origin ??
        (runtime.origin !== undefined
          ? new URL(runtime.origin).origin
          : deps.ambientOrigin());
    } catch (error) {
      return refused("skipped-no-origin", resolved.display, error);
    }
    if (!origin) return refused("skipped-no-origin");
    const url = new URL(resolved.pathname + resolved.search, origin);

    // Resolved with the collecting context, so a store's own background
    // writes are waited for too. A factory throw maps to no-store.
    const ctx = createCollectingExecutionContext(runtime.ctx);
    let cacheConfig: HandlerCacheConfig | undefined;
    let configError: unknown;
    try {
      cacheConfig = deps.resolveCacheConfig(runtime.env, ctx);
    } catch (error) {
      configError = error;
    }
    if (!cacheConfig?.store || cacheConfig.enabled === false) {
      return refused("no-store", url.href, configError);
    }

    const devServer = deps.isViteDevServer();
    if (resolveWarmStoreScope(cacheConfig.store, devServer) === "local") {
      if (!followUp && devServer && !warnedNotShared) {
        warnedNotShared = true;
        const name = cacheConfig.store.constructor?.name;
        console.warn(
          `[rango] router.prerender("${resolved.display}") did not warm: the ` +
            `cache store${name && name !== "Object" ? ` (${name})` : ""} ` +
            `declares ${
              cacheConfig.store.scope === undefined
                ? "no scope"
                : `scope "${String(cacheConfig.store.scope)}"`
            }, so entries written here serve no other process, isolate or ` +
            "edge location. Warming needs a store whose scope is " +
            '"global" or "regional" (CFCacheStore with kv, ' +
            "VercelCacheStore), or a custom store that declares one.",
        );
      }
      return refused("skipped-store-not-shared", url.href);
    }

    const outcome = await runWarmRequest({
      url,
      mode,
      cacheConfig,
      env: runtime.env,
      ctx,
      fetch: deps.fetch,
    });
    return composeWarmResult(outcome, url.href, match.routeName);
  }

  /** The requestless render of an on-demand route into the prerender store (#640). */
  async function renderOnDemand(
    pathname: string,
    display: string,
    match: PrerenderMatchInfo,
    runtime: PrerenderRuntime<TEnv>,
    options: PrerenderRunOptions,
    version: string,
  ): Promise<PrerenderResult> {
    // The prerender factory is user code like tags()/store.set: a throw (e.g.
    // a missing binding tripping store construction) must map to a result, not
    // escape run() — which would reject refresh() despite throwOnError: false
    // and abort a many() batch with no per-target results. A throw leaves
    // config undefined, so it funnels into the same no-store return.
    let config: PrerenderConfig<TEnv> | undefined;
    let configError: unknown;
    try {
      config = deps.resolveConfig(runtime.env, runtime.ctx);
    } catch (err) {
      configError = err;
    }
    if (!config?.store) {
      return {
        ok: false,
        path: "on-demand",
        status: "no-store",
        target: display,
        routeName: match.routeName,
        ...(configError !== undefined ? { error: configError } : {}),
      };
    }

    const key: PrerenderKey = {
      routerId: deps.routerId,
      version,
      routeName: match.routeName,
      paramHash: hashParams(match.params),
    };
    const keyStr = serializePrerenderKey(key);

    // onlyIfStale: the cron-sweep opt-in. A CMS webhook (default) always renders,
    // because it fires precisely when content changed. This is the only path that
    // returns already-fresh, reported with the existing entry's ttl/tags.
    if (options.onlyIfStale) {
      // An unreadable or unverifiable entry is "couldn't confirm fresh":
      // render, never throw (one result per target, many() keeps going).
      const existing = await readVerifiedStoredEntry(
        config.store,
        key,
        match.params,
      );
      if (existing && !isStoredEntryStale(existing, Date.now())) {
        const existingTtl =
          existing.meta.staleAt != null
            ? Math.round(
                (existing.meta.staleAt - existing.meta.storedAt) / 1000,
              )
            : undefined;
        return {
          ok: true,
          path: "on-demand",
          status: "already-fresh",
          target: display,
          routeName: match.routeName,
          key: keyStr,
          tags: existing.meta.tags,
          ...(existingTtl != null ? { ttl: existingTtl } : {}),
        };
      }
    }

    let produced: ProducerOutput | null;
    try {
      produced = await deps.runProducer({
        pathname,
        isPassthrough: match.isPassthrough,
        env: runtime.env,
        dev: deps.isDev(),
      });
    } catch (err) {
      if (isPrerenderPersonalizationError(err)) {
        return {
          ok: false,
          path: "on-demand",
          status: "skipped-personalized",
          target: display,
          routeName: match.routeName,
        };
      }
      // #587: matchForPrerender already threads throwOnError so a render throw
      // surfaces here rather than baking a frozen error page. Keep the old entry.
      return {
        ok: false,
        path: "on-demand",
        status: "render-failed",
        target: display,
        routeName: match.routeName,
        error: err,
      };
    }

    if (!produced) {
      return {
        ok: false,
        path: "on-demand",
        status: "no-match",
        target: display,
        routeName: match.routeName,
      };
    }
    if (produced.passthrough) {
      return {
        ok: false,
        path: "on-demand",
        status: "skipped-passthrough",
        target: display,
        routeName: match.routeName,
      };
    }

    // Resolve soft TTL + tags from the route's onDemand config (read off the
    // loaded route entry by the producer), falling back to the router default.
    const ttl = produced.onDemandConfig?.ttl ?? config.ttl;
    let tags: string[] = [];
    try {
      // The user-supplied tags callback runs here; a throw from it must not
      // escape run() (which would bypass the result contract and abort a many()
      // batch) — keep it inside the store guard so it maps to store-failed.
      const routeTags = produced.onDemandConfig?.tags;
      const rawTags =
        typeof routeTags === "function"
          ? routeTags({ params: match.params })
          : (routeTags ?? []);
      // Same normalization as cache({ tags }): trimmed, no empties, no duplicates.
      tags =
        normalizeTagList(
          [...rawTags].filter((t): t is string => typeof t === "string"),
        ) ?? [];
      // The router composes the envelope; the store only persists it.
      await config.store.set(
        key,
        composeStoredEntry(
          key,
          { segments: produced.segments, handles: produced.handles },
          { ...(ttl != null ? { ttl } : {}), tags, params: match.params },
          Date.now(),
        ),
      );
    } catch (err) {
      // Replace-on-success: a failed write leaves the prior durable entry (and
      // the bundled manifest fallback) in place.
      return {
        ok: false,
        path: "on-demand",
        status: "store-failed",
        target: display,
        routeName: match.routeName,
        error: err,
      };
    }

    return {
      ok: true,
      path: "on-demand",
      status: "rendered",
      target: display,
      routeName: match.routeName,
      key: keyStr,
      tags,
      ...(ttl != null ? { ttl } : {}),
    };
  }

  let warnedNoStore = false;
  let warnedNoRevalidate = false;

  async function many(
    runtime: PrerenderRuntime<TEnv>,
    targets: ReadonlyArray<PrerenderTarget<TRoutes>>,
    options: PrerenderManyOptions = {},
  ): Promise<PrerenderResult[]> {
    // Default to 1 for any invalid concurrency (undefined, NaN, < 1). Without
    // this, Math.floor(NaN) -> NaN spawns zero workers and many() resolves to an
    // array of holes that reports nothing.
    const raw = options.concurrency;
    const concurrency =
      typeof raw === "number" && Number.isFinite(raw) && raw >= 1
        ? Math.floor(raw)
        : 1;
    const version = deps.resolveVersion();
    return runWithConcurrency(targets, concurrency, (target) =>
      // throwOnError propagates per-item so the batch stops on the first failure;
      // without it, every target yields a result.
      refresh(target, runtime, options, version),
    );
  }

  async function markStale(
    runtime: PrerenderRuntime<TEnv>,
    tags: string[],
  ): Promise<void> {
    if (tags.length === 0) return;
    const config = deps.resolveConfig(runtime.env, runtime.ctx);
    if (!config?.store.markStale) {
      // A void return makes a misconfigured caller (no store, or a store
      // without tag support) look like success: a dead CMS webhook.
      if (deps.isDev() && !warnedNoStore) {
        warnedNoStore = true;
        console.warn(
          "[rango] prerender.markStale() is a no-op: " +
            (config?.store
              ? "the configured store does not implement markStale."
              : "no prerender store is configured."),
        );
      }
      return;
    }
    if (!config.onRevalidate && deps.isDev() && !warnedNoRevalidate) {
      warnedNoRevalidate = true;
      console.warn(
        "[rango] prerender.markStale() marked entries stale, but no " +
          "onRevalidate is configured, so a stale hit schedules nothing. The " +
          "entries keep serving until router.prerender() re-renders them " +
          "(for example a sweep with { onlyIfStale: true }).",
      );
    }
    await config.store.markStale(tags);
  }

  // Binding does no work: the config factory, version and manifest resolve per
  // call. The warn-once flags live on the trigger, shared by every bound runner.
  return (runtime: PrerenderRuntime<TEnv>): PrerenderRunner<TRoutes> => {
    const runner = ((target, options) =>
      refresh(target, runtime, options)) as PrerenderRunner<TRoutes>;
    runner.many = (targets, options) => many(runtime, targets, options);
    runner.markStale = (tags) => markStale(runtime, tags);
    return runner;
  };
}

/**
 * Bounded-concurrency map preserving input order. Rejects on the first task
 * error (used so `many({ throwOnError })` stops the batch). The abort flag is
 * load-bearing: Promise.all rejects on the first worker error while the other
 * workers are mid-await — without it they would drain the entire remaining
 * batch (rendering and writing, results discarded) after the caller has
 * already seen the throw. In-flight items still settle; no new item starts.
 */
async function runWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let aborted = false;
  async function worker(): Promise<void> {
    while (!aborted && next < items.length) {
      const i = next++;
      try {
        results[i] = await task(items[i]);
      } catch (err) {
        aborted = true;
        throw err;
      }
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
