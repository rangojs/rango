import type { TrailingSlashMode } from "../types.js";
import type { AllUseItems, UrlPatternsBrand } from "../route-types.js";
import type { SearchSchema } from "../search-params.js";
import { RESPONSE_TYPE } from "./response-types.js";
import type { DefaultEnv } from "../types.js";
import type { PathHelpers } from "./path-helper-types.js";

/**
 * Builder function accepted by urls() and as a shorthand for routes()/urls option.
 * When passed directly to routes() or createRouter({ urls }), it is wrapped in urls() automatically.
 */
export type UrlBuilder<
  TEnv = DefaultEnv,
  TItems extends readonly (AllUseItems | readonly AllUseItems[])[] =
    readonly AllUseItems[],
> = (helpers: PathHelpers<TEnv>) => TItems;

/**
 * Sentinel type for unnamed routes.
 * Using a branded string instead of `never` prevents TypeScript from
 * widening array type inference when mixing named and unnamed routes.
 */
export type UnnamedRoute = "$unnamed";

/**
 * Sentinel type for include() mounts that stay local to the mounted module.
 * This keeps child route names out of the parent/global type map while still
 * allowing the mounted module to use its own local route names internally.
 *
 * Branded with a symbol key so it cannot be accidentally produced by user code.
 */
declare const LOCAL_ONLY_BRAND: unique symbol;
export type LocalOnlyInclude = string & { [LOCAL_ONLY_BRAND]: void };

/**
 * Options for path() function
 */
/**
 * Options for the `ppr` path option (PPR shell caching — Axis 2, see
 * docs/design/ppr-shell-resume.md and the /ppr skill). Declaring
 * `ppr: true | PartialPrerenderProps` on a page route opts that DOCUMENT into
 * shell capture: the rendered HTML shell (everything that is not a live hole) is
 * cached and, on a later GET, flushed immediately while fizz resumes only the
 * holes. Serving is integral to the router — there is no middleware to mount;
 * the shell store is the app-level `createRouter({ cache })` store (which must
 * implement the `getShell`/`putShell` family).
 */
export interface PartialPrerenderProps {
  /**
   * Shell time-to-live in seconds. Defaults to 300 (`ppr: true` uses the same
   * default).
   */
  ttl?: number;
  /**
   * Stale-while-revalidate window in seconds: a stale shell is still served
   * while a background recapture refreshes it.
   */
  swr?: number;
  /**
   * Operational tags attached to the captured shell entry for
   * `updateTag()`/`revalidateTag()`-driven eviction. UNIONED with the tags the
   * capture render auto-collects (the shell's own non-loader request tags).
   */
  tags?: string[];
  /**
   * Upper bound (serialized UTF-8 bytes) on the capture data snapshot riding
   * inside the shell entry. The snapshot duplicates every cache-store value
   * the capture pinned, so a page over a large cache() segment can push the
   * entry toward store value limits (Cloudflare KV caps a value at 25 MiB).
   * Over the cap the snapshot is skipped: the shell is still stored and
   * served, but pinned reads fall back to the live store, so drifted cached
   * content can hydration-mismatch and be repaired client-side (the
   * pre-snapshot behavior). Reported once per key. Defaults to 8 MiB.
   */
  maxSnapshotBytes?: number;
}

export interface PathOptions<
  TName extends string = string,
  TSearch extends SearchSchema = {},
> {
  /** Route name for href() lookups */
  name?: TName;
  /**
   * PPR shell caching opt-in for this page route (document-level). `true` uses
   * the default policy (ttl 300); an object sets ttl/swr/tags. See
   * {@link PartialPrerenderProps}. Routes without this option are pure axis 1 —
   * no capture, no store reads, no logs.
   */
  ppr?: boolean | PartialPrerenderProps;
  /** Search param schema for typed query parameters */
  search?: TSearch;
  /** Trailing slash behavior: "never" (redirect /path/ to /path), "always" (redirect /path to /path/), "ignore" (match both) */
  trailingSlash?: TrailingSlashMode;
  /** Response type marker (set by path.json(), etc.) */
  [RESPONSE_TYPE]?: string;
}

/**
 * Result of urls() - contains the route definitions
 */
export interface UrlPatterns<
  TEnv = any,
  TRoutes extends Record<string, any> = Record<string, string>,
  TResponses extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Internal: compiled handler function */
  readonly handler: () => AllUseItems[];
  /** Internal: trailing slash config per route name */
  readonly trailingSlash: Record<string, TrailingSlashMode>;
  /** Brand for type checking */
  readonly [UrlPatternsBrand]: void;
  /** Environment type brand (phantom) */
  readonly _env?: TEnv;
  /** Routes type brand (phantom) - carries route name -> pattern mapping */
  readonly _routes?: TRoutes;
  /** Responses type brand (phantom) - carries route name -> response data type mapping */
  readonly _responses?: TResponses;
}

/**
 * Extract the phantom env type carried by a UrlPatterns value.
 */
export type UrlPatternsEnv<T> =
  T extends UrlPatterns<infer TEnv, any, any> ? TEnv : never;

/**
 * Guards `routes()` env compatibility without over-constraining.
 *
 * - An env-agnostic block (its env is `unknown` — e.g. a shared urls() module,
 *   or an app that does not augment `Rango.Env`) attaches to any router.
 * - A block carrying a concrete env is accepted only when the router env
 *   (`TRouterEnv`) satisfies it; resolves to `never` otherwise, so a
 *   `urls<{ DB: D1Database }>()` cannot be mounted on a `createRouter<{}>()`.
 *
 * Use as `patterns: T & EnvCompatible<T, TEnv>` so `T` still infers from the
 * argument — a bare `EnvCompatible<T, TEnv>` parameter sits in a non-inferrable
 * conditional position and would collapse `T` to its constraint.
 *
 * Known limitation: `TRouterEnv extends ...` distributes over a union router env,
 * so a `urls<A>()` block is accepted on `createRouter<A | B>()` even though the
 * `B` arm cannot supply `A`'s env. Suppressing distribution with
 * `[TRouterEnv] extends [...]` would close that edge but breaks the common
 * generic-`TEnv` call sites (a deferred type parameter can't resolve the tuple
 * conditional, so the intersection stops reducing to `T`). A router has one env,
 * so a union env is not a supported pattern; the distributive form is kept.
 */
export type EnvCompatible<TPatterns, TRouterEnv> =
  unknown extends UrlPatternsEnv<TPatterns>
    ? TPatterns
    : TRouterEnv extends UrlPatternsEnv<TPatterns>
      ? TPatterns
      : never;

/**
 * Options for include()
 */
export interface IncludeOptions<TNamePrefix extends string = string> {
  /**
   * Name prefix for all routes in this pattern set.
   *
   * - `{ name: "blog" }` — children become `blog.index`, `blog.detail`, etc.
   *   Visible in generated route types and resolvable globally via `reverse("blog.index")`.
   * - `{ name: "" }` — children merge into the parent namespace with no prefix.
   *   Equivalent to defining the routes inline at the include site.
   * - Omitted — children live in a private local scope, hidden from the
   *   generated route map and global reverse resolution. Only dot-local
   *   reverse (e.g. `reverse(".child")`) works from inside the module.
   */
  name?: TNamePrefix;
}
