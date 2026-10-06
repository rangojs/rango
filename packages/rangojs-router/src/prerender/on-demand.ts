/**
 * Public type surface for on-demand (ISR-style) prerender: the router
 * `prerender` config option, the `router.prerender({ env, ctx })` runner, its typed
 * target, and the inspectable result union.
 *
 * Types only — safe to import from router options, the public interfaces, the
 * testing barrel, and platform adapters without pulling RSC deps.
 */

import type { ExecutionContext } from "../types/request-scope.js";
import type { IsEmptyObject, ParamsFor } from "../reverse.js";
import type { WritablePrerenderStore } from "./writable-store.js";
import type { ShellCaptureRefusal } from "../rsc/shell-capture-constants.js";

declare const prerenderTargetBrand: unique symbol;

/**
 * The target `onRevalidate` receives: a plain `{ route, params }` that goes
 * straight into a queue message. The type-only brand (never present at
 * runtime) lets the runner (`router.prerender({ env })(target)` / `.many()`) accepts it with no cast on a
 * router typed with named routes, while a hand-written `{ route: "typo" }`
 * stays a type error there. After a JSON round trip, assert it back:
 * `JSON.parse(raw) as PrerenderTargetObject`.
 */
export interface PrerenderTargetObject {
  route: string;
  params: Record<string, string>;
  readonly [prerenderTargetBrand]: true;
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
 * A prerender target: a typed named-route object, a path-like string/URL
 * (`router.reverse()` output composes for free), or the `onRevalidate` target.
 */
export type PrerenderTarget<TRoutes = {}> =
  | string
  | URL
  | PrerenderRouteTarget<TRoutes>
  | PrerenderTargetObject;

/** Env + platform capabilities bound once by `router.prerender({ env, ctx })`. */
export interface PrerenderRuntime<TEnv = any> {
  /** The live env: the producer's `ctx.env` (not the build's `buildEnv`). */
  env: TEnv;
  /** Cloudflare `ExecutionContext`; absent on node/Vercel. */
  ctx?: ExecutionContext;
  /**
   * The origin a warm requests a path or `{ route, params }` target on, for
   * example `"https://shop.example"`. Cache keys carry the host, so a warm
   * must request the host visitors use. A full-URL target uses its own
   * origin; without this option the runner uses the origin of the request it
   * is called from (an action, a route handler, `onRevalidate`), and with
   * neither a warm returns `skipped-no-origin`. An on-demand route's
   * requestless render never needs it.
   */
  origin?: string;
}

/** Per-call options of the bound runner. */
export interface PrerenderRunOptions {
  /** Throw on failure instead of returning an `{ ok: false }` result. */
  throwOnError?: boolean;
  /**
   * Only refresh what is cold or stale (cron-sweep opt-in), and the only
   * path that can return `already-fresh`. On an on-demand route the stored
   * entry is rendered only when stale. On any other route the warm reads its
   * caches normally instead of forcing misses, so a fresh entry is left
   * alone, a stale one refreshes and a missing one is written.
   */
  onlyIfStale?: boolean;
}

/** Per-call options of the bound runner's `.many()`. */
export interface PrerenderManyOptions extends PrerenderRunOptions {
  /** Max concurrent renders in a batch (default 1; any invalid value is 1). */
  concurrency?: number;
}

/**
 * What a warm request wrote, by cache. On a result of the warm path, and on
 * an on-demand result whose route was also warmed.
 */
export interface PrerenderWarmCaches {
  /**
   * Store writes that landed, by store family: `record` (route `cache()`),
   * `item` (`"use cache"` and loader `cache()`), `response` (the document
   * cache and response routes), `shell` (the `ppr` shell).
   */
  writes: { record: number; item: number; response: number; shell: number };
  /**
   * The `ppr` shell; absent on a route without `ppr`. `fresh` is
   * `onlyIfStale` finding a servable shell; `not-eligible` is a request the
   * shell path passed on (an active nonce, a store without shells, the
   * route's own `cache()` opt-out, a buffered response).
   */
  shell?:
    | "stored"
    | "fresh"
    | "refused"
    | "no-shell"
    | "not-eligible"
    | "skipped-capacity"
    | "skipped-queue-timeout"
    | "error";
  /** Why the capture refused to store the shell. */
  refusal?: ShellCaptureRefusal;
  /** The document cache, when `createDocumentCacheMiddleware` ran. */
  document?: "stored" | "not-cacheable";
}

/**
 * Inspectable result, one per target. The trigger does not force callers
 * into try/catch; `throwOnError: true` opts into throwing for admin/CI
 * endpoints. `path` says what ran: `on-demand` is the requestless render of a
 * `Prerender(..., { onDemand })` route into the prerender store, `warm` is a
 * request through the router's handler that rewrites the route's runtime
 * caches.
 */
export type PrerenderResult =
  | {
      ok: true;
      path: "on-demand";
      /** `already-fresh` only occurs with `onlyIfStale: true`. */
      status: "rendered" | "already-fresh";
      target: string;
      routeName: string;
      /** Opaque, for debugging/logs only — not a stable format. */
      key: string;
      tags: string[];
      /** Absent = never stale. */
      ttl?: number;
      /**
       * The warm request that followed the store write. Absent when the app
       * store is not shared, no origin resolved, or nothing was rendered.
       */
      caches?: PrerenderWarmCaches;
    }
  | {
      ok: true;
      path: "warm";
      /** `already-fresh` only occurs with `onlyIfStale: true`. */
      status: "warmed" | "already-fresh";
      /** The absolute URL that was requested. */
      target: string;
      routeName: string;
      /** The warm response's HTTP status. */
      responseStatus: number;
      caches: PrerenderWarmCaches;
    }
  | {
      ok: false;
      /** Absent when no route matched: every other result is past the match. */
      path?: "on-demand" | "warm";
      status:
        | "no-match"
        // No prerender store (on-demand), or no `createRouter({ cache })` (warm).
        | "no-store"
        | "skipped-personalized"
        | "skipped-unsupported-target"
        // The route (a Passthrough + onDemand route) returned ctx.passthrough()
        // for this param set — no shared payload to persist; the live handler
        // keeps serving it.
        | "skipped-passthrough"
        // The app store's entries are not readable beyond the place the call
        // runs (SegmentCacheStore.scope), so a warm would serve no one else.
        | "skipped-store-not-shared"
        // A path or { route, params } target with no origin to request it on.
        | "skipped-no-origin"
        // A ppr route whose shell was not stored (caches.shell says why).
        | "shell-not-stored"
        // The request rendered and no cache wrote anything.
        | "skipped-uncached"
        | "render-failed"
        | "store-failed";
      target: string;
      routeName?: string;
      /** The warm response's HTTP status, when a warm request ran. */
      responseStatus?: number;
      caches?: PrerenderWarmCaches;
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
   * the runner's `markStale()`. A separate namespace from `cacheTag()` /
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
   * `(target, env, ctx) => router.prerender({ env, ctx })(target)` is safe in a single
   * process; across isolates, point it at a queue, which owns dedup.
   */
  onRevalidate?: (
    target: PrerenderTargetObject,
    env: TEnv,
    /** The stale request's execution context; absent where none exists. */
    ctx?: ExecutionContext,
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
 * The runner `router.prerender({ env, ctx })` returns: callable per target,
 * plus `.many` / `.markStale`. Typing rides the phantom `TRoutes` accumulator,
 * like `reverse`.
 */
export interface PrerenderRunner<TRoutes = {}> {
  (
    target: PrerenderTarget<TRoutes>,
    options?: PrerenderRunOptions,
  ): Promise<PrerenderResult>;
  many(
    targets: ReadonlyArray<PrerenderTarget<TRoutes>>,
    options?: PrerenderManyOptions,
  ): Promise<PrerenderResult[]>;
  /**
   * Mark this router's stored entries carrying one of `tags` stale. Marking only: the
   * entries keep serving, and a stale hit schedules `onRevalidate` when one is
   * configured. Nothing is deleted or re-rendered here.
   */
  markStale(tags: string[]): Promise<void>;
}

/**
 * The `router.prerender` function: binds the runtime (`env`, `ctx`) and returns
 * the {@link PrerenderRunner}. Binding does no work; the config factory is
 * resolved per call.
 */
export type PrerenderFn<TEnv = any, TRoutes = {}> = (
  runtime: PrerenderRuntime<TEnv>,
) => PrerenderRunner<TRoutes>;
