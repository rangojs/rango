/**
 * `router.prerender()` trigger factory.
 *
 * Builds the `router.prerender` binder: `(runtime) => runner`, the runner being the requestless refresh callable (plus `.many` / `.markStale`)
 * from router-supplied deps. Pure and testable: all router internals (reverse,
 * match, the producer) arrive as injected functions, so this module has no RSC
 * imports and can be unit-tested with fakes.
 *
 * Contract highlights (see docs/design/ondemand-prerender.md):
 * - Requestless: the producer render never inherits the caller's request state.
 * - Refresh always renders and replaces; `onlyIfStale` is the cron-sweep opt-in
 *   and the only path that returns `already-fresh`.
 * - A failed render/store keeps the previous entry (replace-on-success).
 * - Path-only targets in v1: a target with search/hash is unsupported.
 */

import type { SerializedSegmentData } from "../cache/types.js";
import type { ExecutionContext } from "../types/request-scope.js";
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
  /** Set when the target carries search/hash (v1 unsupported). */
  unsupported?: boolean;
}

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
    return { display: route };
  }
  return fromUrlLike(pathname, pathname);
}

function fromUrlLike(raw: string, display: string): ResolvedTarget {
  let url: URL;
  try {
    // Host is irrelevant (prerender keys are route+params only); a relative path
    // resolves against the dummy base, a full URL keeps its own path.
    url = new URL(raw, "http://prerender.local");
  } catch {
    return { display, unsupported: true };
  }
  if (url.search || url.hash) {
    // Path-only in v1: search/hash would silently persist under the base key.
    return { display, unsupported: true };
  }
  return { pathname: url.pathname, display: url.pathname };
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
    if (!match.isOnDemand) {
      return {
        ok: false,
        status: "skipped-not-on-demand",
        target: display,
        routeName: match.routeName,
      };
    }

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
        pathname: resolved.pathname,
        isPassthrough: match.isPassthrough,
        env: runtime.env,
        dev: deps.isDev(),
      });
    } catch (err) {
      if (isPrerenderPersonalizationError(err)) {
        return {
          ok: false,
          status: "skipped-personalized",
          target: display,
          routeName: match.routeName,
        };
      }
      // #587: matchForPrerender already threads throwOnError so a render throw
      // surfaces here rather than baking a frozen error page. Keep the old entry.
      return {
        ok: false,
        status: "render-failed",
        target: display,
        routeName: match.routeName,
        error: err,
      };
    }

    if (!produced) {
      return {
        ok: false,
        status: "no-match",
        target: display,
        routeName: match.routeName,
      };
    }
    if (produced.passthrough) {
      return {
        ok: false,
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
        status: "store-failed",
        target: display,
        routeName: match.routeName,
        error: err,
      };
    }

    return {
      ok: true,
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
