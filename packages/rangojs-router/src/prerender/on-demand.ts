/**
 * Public type surface for on-demand (ISR-style) prerender: the router
 * `prerender` config option, the `router.prerender()` trigger, its typed
 * target, and the inspectable result union.
 *
 * Types only — safe to import from router options, the public interfaces, the
 * testing barrel, and platform adapters without pulling RSC deps.
 */

import type { ExecutionContext } from "../types/request-scope.js";
import type { IsEmptyObject, ParamsFor } from "../reverse.js";
import type { WritablePrerenderStore } from "./writable-store.js";

/**
 * JSON-serializable target passed to `onRevalidate` and accepted by
 * `router.prerender({ route, params })`. Kept plain so it can go straight into
 * a queue message.
 */
export interface PrerenderTargetObject {
  route: string;
  params: Record<string, string>;
}

/**
 * Route map used to type the object target. When the fluent `TRoutes` phantom is
 * empty (the common `createRouter().routes(...)` case leaves it `{}`), fall back
 * to the generated global route map — the same fallback `Prerender<"name">` and
 * `reverse` use — so `router.prerender({ route, params })` stays typed without an
 * explicit route-type parameter.
 */
type PrerenderRouteMap<TRoutes> = keyof TRoutes extends never
  ? keyof Rango.GeneratedRouteMap extends never
    ? {}
    : Rango.GeneratedRouteMap
  : TRoutes;

/**
 * Typed object target, derived from the router's route map the same way
 * `reverse` is. No-param routes may omit `params`.
 */
type PrerenderRouteTarget<TRoutes> = {
  [TName in keyof PrerenderRouteMap<TRoutes> & string]: IsEmptyObject<
    ParamsFor<PrerenderRouteMap<TRoutes>, TName>
  > extends true
    ? { route: TName; params?: Record<string, never> }
    : { route: TName; params: ParamsFor<PrerenderRouteMap<TRoutes>, TName> };
}[keyof PrerenderRouteMap<TRoutes> & string];

/**
 * A prerender target: a typed named-route object, or a path-like string/URL.
 * `router.reverse()` output composes for free since strings are accepted.
 */
export type PrerenderTarget<TRoutes = {}> =
  | string
  | URL
  | PrerenderRouteTarget<TRoutes>;

/** Env + platform capabilities the trigger threads to the requestless producer. */
export interface PrerenderRuntime<TEnv = any> {
  /** The live env: the producer's `ctx.env` (not the build's `buildEnv`). */
  env: TEnv;
  /** Cloudflare `ExecutionContext`; absent on node/Vercel. */
  ctx?: ExecutionContext;
  /** Throw on failure instead of returning an `{ ok: false }` result. */
  throwOnError?: boolean;
  /**
   * Only render when the current entry is stale (cron-sweep opt-in). This is the
   * only path that can return `already-fresh`; a plain refresh always renders.
   */
  onlyIfStale?: boolean;
}

export interface PrerenderManyRuntime<
  TEnv = any,
> extends PrerenderRuntime<TEnv> {
  /** Max concurrent renders in a batch (default 1). */
  concurrency?: number;
}

/**
 * Inspectable result. The trigger does not force callers into try/catch;
 * `throwOnError: true` opts into throwing for admin/CI endpoints.
 */
export type PrerenderResult =
  | {
      ok: true;
      /** `already-fresh` only occurs with `onlyIfStale: true`. */
      status: "rendered" | "already-fresh";
      target: string;
      routeName: string;
      /** Opaque, for debugging/logs only — not a stable format. */
      key: string;
      tags: string[];
      /** Absent = never stale. */
      ttl?: number;
    }
  | {
      ok: false;
      status:
        | "no-match"
        | "no-store"
        | "skipped-not-on-demand"
        | "skipped-personalized"
        | "skipped-unsupported-target"
        // The route (a Passthrough + onDemand route) returned ctx.passthrough()
        // for this param set — no shared payload to persist; the live handler
        // keeps serving it.
        | "skipped-passthrough"
        | "render-failed"
        | "store-failed";
      target: string;
      routeName?: string;
      error?: unknown;
    };

/**
 * Per-route on-demand opt-in, carried inside `PrerenderOptions.onDemand`. Any
 * truthy spelling works (literal, spread, imported const): producer retention
 * is driven by the evaluated route manifest, not a textual scan of the call.
 */
export interface OnDemandRouteConfig {
  /** Soft TTL (seconds) for entries refreshed for this route. Overrides the router `ttl`. */
  ttl?: number;
  /**
   * Tags stamped on the stored entry, addressable via
   * `router.prerender.markStale()`. A separate namespace from `cacheTag()` /
   * `updateTag()` / `revalidateTag()`, which never reach the prerender store.
   */
  tags?: string[] | ((target: { params: Record<string, string> }) => string[]);
}

export type OnDemandOption = boolean | OnDemandRouteConfig;

/**
 * Env-resolved prerender store configuration. Same union shape as the `cache`
 * option: a plain object or a factory resolved per request/per call, never at
 * `createRouter()` time.
 */
export interface PrerenderConfig<TEnv = any> {
  store: WritablePrerenderStore;
  /**
   * Default soft TTL (seconds) for a route whose `onDemand` sets none. Absent
   * = never stale. Soft: a stale entry keeps serving; staleness only decides
   * whether `onRevalidate` is scheduled. Entries never expire.
   */
  ttl?: number;
  /**
   * Stale-while-revalidate: its presence is the opt-in. Scheduled through
   * `waitUntil` on a stale overlay hit (the stale entry still serves) with
   * the JSON-serializable target and the live env. Runs at most once per
   * stale key per isolate while one is in flight (one running longer than
   * 15 s counts as finished, so a hung call cannot block the key), so
   * `(target, env) => router.prerender(target, { env })` is safe in a single
   * process; across isolates, point it at a queue, which owns dedup.
   */
  onRevalidate?: (
    target: PrerenderTargetObject,
    env: TEnv,
  ) => void | Promise<void>;
}

/**
 * @internal Per-request resolution of the prerender config plus the key
 * version. Threaded onto the request context by the RSC handler and read by
 * the serve-path overlay lookup.
 */
export interface ResolvedPrerender<TEnv = any> {
  /** The resolved config; the store is `config.store`. */
  config: PrerenderConfig<TEnv>;
  routerId: string;
  /** The router's cache version for overlay keys (resolvePrerenderVersion). */
  version: string;
}

/**
 * The `router.prerender` callable, plus its `.many` / `.markStale`
 * companions. Typing rides the phantom `TRoutes` accumulator, like `reverse`.
 */
export interface PrerenderFn<TEnv = any, TRoutes = {}> {
  (
    target: PrerenderTarget<TRoutes>,
    runtime: PrerenderRuntime<TEnv>,
  ): Promise<PrerenderResult>;
  many(
    targets: ReadonlyArray<PrerenderTarget<TRoutes>>,
    runtime: PrerenderManyRuntime<TEnv>,
  ): Promise<PrerenderResult[]>;
  /**
   * Mark every stored entry carrying one of `tags` stale. Marking only: the
   * entries keep serving, and a stale hit schedules `onRevalidate` when one is
   * configured. Nothing is deleted or re-rendered here.
   */
  markStale(
    tags: string[],
    runtime: { env: TEnv; ctx?: ExecutionContext },
  ): Promise<void>;
}
