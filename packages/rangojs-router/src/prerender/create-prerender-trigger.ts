/**
 * `router.prerender()` trigger factory.
 *
 * Builds the requestless refresh callable (plus `.many` / `.invalidateTags`)
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
import { hashParams } from "./param-hash.js";
import { isPrerenderPersonalizationError } from "./producer-guard.js";
import {
  isStoredEntryStale,
  serializePrerenderKey,
  type PrerenderKey,
} from "./writable-store.js";
import type {
  OnDemandRouteConfig,
  PrerenderConfig,
  PrerenderFn,
  PrerenderManyRuntime,
  PrerenderResult,
  PrerenderRuntime,
  PrerenderRuntimeBase,
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
  /** Per-deploy identity (VERSION). */
  buildId: string;
  /** True when running under Vite dev (drives the producer context's `dev`). */
  isDev: () => boolean;
  /** Load the per-router manifest/trie before matching, as router.fetch does. */
  ensureManifest: () => Promise<void>;
  /** Resolve the env-scoped prerender config (factory or object); undefined when unconfigured. */
  resolveConfig: (
    env: TEnv,
    ctx: PrerenderRuntimeBase<TEnv>["ctx"],
  ) => PrerenderConfig<TEnv> | undefined;
  /** Reverse an object target to a pathname; undefined when the route name is unknown. */
  reverse: (
    route: string,
    params: Record<string, string>,
  ) => string | undefined;
  /** Match a pathname to route metadata; null when nothing matches. */
  matchRoute: (pathname: string) => PrerenderMatchInfo | null;
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
  ): Promise<PrerenderResult> {
    const result = await run(target, runtime);
    if (!result.ok && runtime.throwOnError) throw new PrerenderError(result);
    return result;
  }

  async function run(
    target: PrerenderTarget<TRoutes>,
    runtime: PrerenderRuntime<TEnv>,
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

    const match = deps.matchRoute(resolved.pathname);
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

    const config = deps.resolveConfig(runtime.env, runtime.ctx);
    if (!config?.store) {
      return {
        ok: false,
        status: "no-store",
        target: display,
        routeName: match.routeName,
      };
    }

    const key: PrerenderKey = {
      routerId: deps.routerId,
      buildId: deps.buildId,
      routeName: match.routeName,
      paramHash: hashParams(match.params),
    };
    const keyStr = serializePrerenderKey(key);

    // onlyIfStale: the cron-sweep opt-in. A CMS webhook (default) always renders,
    // because it fires precisely when content changed. This is the only path that
    // returns already-fresh, reported with the existing entry's ttl/tags.
    if (runtime.onlyIfStale) {
      // A failing stale-check read must not throw (breaking the no-throw /
      // one-result-per-target contract and aborting a many() batch) — treat an
      // unreadable entry as "couldn't confirm fresh" and fall through to render.
      let existing = null;
      try {
        existing = await config.store.get(key, { params: match.params });
      } catch {
        existing = null;
      }
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
    const ttl = produced.onDemandConfig?.ttl ?? config.defaultTtl;
    let tags: string[] = [];
    try {
      // The user-supplied tags callback runs here; a throw from it must not
      // escape run() (which would bypass the result contract and abort a many()
      // batch) — keep it inside the store guard so it maps to store-failed.
      tags = produced.onDemandConfig?.tags?.({ params: match.params }) ?? [];
      await config.store.set(
        key,
        { segments: produced.segments, handles: produced.handles },
        { ...(ttl != null ? { ttl } : {}), tags, params: match.params },
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

  const trigger = refresh as PrerenderFn<TEnv, TRoutes>;

  trigger.many = async (
    targets: ReadonlyArray<PrerenderTarget<TRoutes>>,
    runtime: PrerenderManyRuntime<TEnv>,
  ): Promise<PrerenderResult[]> => {
    // Default to 1 for any invalid concurrency (undefined, NaN, < 1). Without
    // this, Math.floor(NaN) -> NaN spawns zero workers and many() resolves to an
    // array of holes that reports nothing.
    const raw = runtime.concurrency;
    const concurrency =
      typeof raw === "number" && Number.isFinite(raw) && raw >= 1
        ? Math.floor(raw)
        : 1;
    return runWithConcurrency(targets, concurrency, (target) =>
      // throwOnError propagates per-item so the batch stops on the first failure;
      // without it, every target yields a result.
      refresh(target, runtime),
    );
  };

  trigger.invalidateTags = async (
    tags: string[],
    runtime: PrerenderRuntimeBase<TEnv>,
  ): Promise<void> => {
    if (tags.length === 0) return;
    const config = deps.resolveConfig(runtime.env, runtime.ctx);
    await config?.store.invalidateTags?.(tags);
  };

  return trigger;
}

/**
 * Bounded-concurrency map preserving input order. Rejects on the first task
 * error (used so `many({ throwOnError })` stops the batch).
 */
async function runWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await task(items[i]);
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
