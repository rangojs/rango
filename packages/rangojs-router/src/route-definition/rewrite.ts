/**
 * `throw rewrite(target)`: middleware renders another route at the same URL.
 *
 * The thrown Rewrite unwinds to one catch around the global middleware chain
 * (rsc/handler.ts), which moves the SAME request context to the target
 * (server/request-context.ts rebaseRequestContext) and runs the request again
 * from the top: global middleware matched on the target path, the target's
 * route middleware, its render. The browser URL does not change.
 */

import { createVar, contextGet, contextSet } from "../context-var.js";
import { createReverseFunction } from "../router/handler-context.js";
import {
  rebaseRequestContext,
  type RequestContext,
} from "../server/request-context.js";
import type { ExtractParams } from "../types.js";
import type {
  ExtractSearchSchema,
  IsEmptyObject,
  RoutePatternFor,
} from "../reverse.js";
import type { ResolveSearchSchema } from "../search-params.js";
import type { DefaultReverseRouteMap } from "../types/global-namespace.js";

/** Most rewrites one request may take; the next one is a RewriteLoopError. */
export const MAX_REWRITE_HOPS = 5;

/** Response header naming the route path a rewritten request rendered. */
export const REWRITE_HEADER = "x-rango-rewrite";

/**
 * Cross-realm brand: a Vite dev server can load this module twice (the RSC
 * and the SSR graph), so `instanceof` alone misses a Rewrite from the other
 * copy.
 */
const REWRITE_BRAND: unique symbol = Symbol.for("rango.rewrite");

/** The target as written: a path, or a global route name with its params. */
export type RewriteTarget =
  | { readonly path: string }
  | {
      readonly name: string;
      readonly params?: Record<string, string>;
      readonly search?: Record<string, unknown>;
    };

const REWRITE_RULE =
  "throw rewrite() renders another route at the same URL. It works only in " +
  "middleware (router.use() or middleware() in urls()) while it handles a GET " +
  "or HEAD page request: not in a route handler, a loader, a server action, " +
  "intercept middleware or a loader fetch. Use redirect() to send the visitor " +
  "to another URL, and return a Response from middleware for a mutation.";

function describeTarget(target: RewriteTarget): string {
  return "path" in target
    ? `rewrite(${JSON.stringify(target.path)})`
    : `rewrite(${JSON.stringify(target.name)})`;
}

/**
 * The value `rewrite()` returns, thrown by middleware. An Error, so a throw
 * where a rewrite is not supported fails loudly with the rule in its message.
 */
export class Rewrite extends Error {
  name = "Rewrite" as const;
  readonly target: RewriteTarget;

  constructor(target: RewriteTarget) {
    super(`${describeTarget(target)}: ${REWRITE_RULE}`);
    Object.setPrototypeOf(this, Rewrite.prototype);
    this.target = target;
  }
}
Object.defineProperty(Rewrite.prototype, REWRITE_BRAND, { value: true });

/** Whether `value` is a Rewrite thrown by `rewrite()` (ctx.isRewrite). */
export function isRewrite(value: unknown): value is Rewrite {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [REWRITE_BRAND]?: unknown })[REWRITE_BRAND] === true
  );
}

/**
 * The rewrite target overloads for a route map, mirroring the global
 * overloads of `ctx.reverse` (GlobalReverseFunction) with a Rewrite result.
 */
type RouteRewriteFunction<TRoutes> = string extends keyof TRoutes
  ? <TName extends string>(
      name: Exclude<TName, `.${string}` | `/${string}`>,
      params?: Record<string, string>,
      search?: Record<string, unknown>,
    ) => Rewrite
  : {
      <TName extends keyof TRoutes & string>(
        name: IsEmptyObject<
          ExtractParams<RoutePatternFor<TRoutes, TName>>
        > extends true
          ? TName
          : never,
      ): Rewrite;
      <TName extends keyof TRoutes & string>(
        name: TName,
        params: ExtractParams<RoutePatternFor<TRoutes, TName>>,
      ): Rewrite;
      <TName extends keyof TRoutes & string>(
        name: TName,
        params: ExtractParams<RoutePatternFor<TRoutes, TName>>,
        search: ResolveSearchSchema<ExtractSearchSchema<TRoutes, TName>>,
      ): Rewrite;
    };

/**
 * `rewrite(path)` or `rewrite(name, params?, search?)`: a path in this app
 * (basename-prefixed like `redirect()`, may carry `?search`), or a global
 * route name (no `.local` names; a route with params needs them).
 */
export type RewriteFunction<TRoutes = DefaultReverseRouteMap> = ((
  path: `/${string}`,
) => Rewrite) &
  RouteRewriteFunction<TRoutes>;

function createRewrite(
  target: string,
  params?: Record<string, string>,
  search?: Record<string, unknown>,
): Rewrite {
  if (typeof target !== "string" || target === "") {
    throw new TypeError(
      'rewrite() takes a path starting with "/" or a global route name.',
    );
  }
  if (target.startsWith("/")) {
    if (params !== undefined || search !== undefined) {
      throw new TypeError(
        `rewrite(${JSON.stringify(target)}) takes params only with a route name, not with a path.`,
      );
    }
    return new Rewrite({ path: target });
  }
  if (target.startsWith(".")) {
    throw new TypeError(
      `rewrite(${JSON.stringify(target)}): a rewrite resolves global route names only (no include() scope).`,
    );
  }
  return new Rewrite({ name: target, params, search });
}

/**
 * Render another route at the same URL. Throw it from middleware:
 *
 * ```ts
 * router.use(async (ctx, next) => {
 *   if (!locked || ctx.pathname === "/maintenance") return next();
 *   throw rewrite("maintenance");
 * });
 * ```
 *
 * The request runs again as the target (global middleware, route
 * middleware, render) with the same request context: values set before the
 * throw stay readable. `ctx.url` is the target; `ctx.rewrittenFrom` is the
 * visitor's URL. See the `/middleware` skill.
 */
export const rewrite: RewriteFunction = createRewrite as RewriteFunction;

/**
 * Raised when a request is rewritten more than {@link MAX_REWRITE_HOPS}
 * times, or to the URL it is already on. Reported through `onError` (phase
 * "routing") and answered with 508.
 */
export class RewriteLoopError extends Error {
  name = "RewriteLoopError" as const;
  /** The URLs the request moved through, the visitor's first. */
  readonly trail: readonly string[];

  constructor(trail: readonly string[]) {
    super(
      `Infinite rewrite loop: ${trail.join(" -> ")}. A request is rewritten ` +
        `at most ${MAX_REWRITE_HOPS} times, and never to the URL it is on.`,
    );
    Object.setPrototypeOf(this, RewriteLoopError.prototype);
    this.trail = trail;
  }
}

/** Where a rewrite was thrown that cannot honor it. */
export type RewriteSite = "mutation" | "action" | "loader-fetch" | "intercept";

const SITE_MESSAGE: Record<RewriteSite, string> = {
  mutation:
    "middleware threw it while handling a non-GET request (a server action " +
    "or a form post). Return a Response for mutations instead, e.g. " +
    'new Response("Maintenance", { status: 503 }).',
  action:
    "a server action threw it. Use redirect() to send the visitor to another URL.",
  "loader-fetch":
    "it was thrown during a loader fetch (useFetchLoader, load(), " +
    "useRefreshLoaders) or by loader middleware. Return a Response there.",
  intercept:
    "intercept middleware threw it. Rewrite from router.use() or the " +
    "route's middleware(), or return a Response.",
};

/** The error a rewrite becomes at a site that cannot honor it. */
export function rewriteNotSupported(
  rewrite: Rewrite,
  site: RewriteSite,
): Error {
  return new Error(
    `${describeTarget(rewrite.target)} is not supported here: ${SITE_MESSAGE[site]}`,
    { cause: rewrite },
  );
}

/** Run a server action; a rewrite() it throws becomes the site's error. */
export async function rejectActionRewrite<T>(
  run: () => T | Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isRewrite(error)) throw rewriteNotSupported(error, "action");
    throw error;
  }
}

/**
 * Resolve a rewrite's target against the router's route map (global names,
 * no param auto-fill, as middleware `ctx.reverse`) and the request origin.
 * A path is basename-prefixed like `redirect()`. Throws for an unknown name,
 * a missing param, or a target outside this origin.
 */
export function resolveRewriteTarget(
  rewrite: Rewrite,
  routeMap: Record<string, string>,
  base: URL,
  basename?: string,
): URL {
  const { target } = rewrite;
  let path: string;
  if ("path" in target) {
    path = target.path;
    if (
      basename &&
      path !== basename &&
      !path.startsWith(basename + "/") &&
      !path.startsWith(basename + "?")
    ) {
      path = path === "/" ? basename : basename + path;
    }
  } else {
    // `{}`, not undefined: a route with params then throws for the missing
    // ones instead of resolving to its raw pattern.
    path = createReverseFunction(routeMap)(
      target.name,
      target.params ?? {},
      target.search,
    );
  }
  const resolved = new URL(path, base.origin);
  if (resolved.origin !== base.origin) {
    throw new TypeError(
      `${describeTarget(target)} must name a path in this app, not another origin.`,
    );
  }
  resolved.hash = "";
  return resolved;
}

interface RewriteTrail {
  readonly hops: number;
  readonly trail: readonly string[];
}

/**
 * The hops one request took, in the request's variables under a token no
 * user code can reach, so a middleware cannot reset the loop count.
 */
const REWRITE_TRAIL = createVar<RewriteTrail>();

/**
 * Count one hop from `from` to `to` (clean URLs) and return its number.
 * Throws RewriteLoopError past {@link MAX_REWRITE_HOPS} or when `to` is the
 * URL the request is on.
 */
export function recordRewriteHop(
  variables: Record<string, unknown>,
  from: URL,
  to: URL,
): number {
  const prior = contextGet(variables, REWRITE_TRAIL) as
    | RewriteTrail
    | undefined;
  const fromKey = from.pathname + from.search;
  const toKey = to.pathname + to.search;
  const trail = [...(prior?.trail ?? [fromKey]), toKey];
  const hops = (prior?.hops ?? 0) + 1;
  if (toKey === fromKey || hops > MAX_REWRITE_HOPS) {
    throw new RewriteLoopError(trail);
  }
  contextSet(variables, REWRITE_TRAIL, { hops, trail });
  return hops;
}

/**
 * The raw URL of a rewritten pass: the target's path and search plus the
 * visitor's internal `_rsc*` transport params, so a navigation stays a
 * navigation (same segments, version, partial flag).
 */
function rewriteTransportUrl(target: URL, visitorRaw: URL): URL {
  const raw = new URL(target);
  visitorRaw.searchParams.forEach((value, key) => {
    if (key.startsWith("_rsc")) raw.searchParams.append(key, value);
  });
  return raw;
}

/** The next pass of a rewritten request (applyRewrite). */
export interface RewritePass {
  request: Request;
  /** The pass's raw URL, `_rsc*` params included. */
  url: URL;
  /** The target's clean URL. */
  target: URL;
  hops: number;
}

/**
 * Move the request context to `rewrite`'s target for the next pass: check
 * that this request can be rewritten, resolve the target, count the hop,
 * then rebase the context (rebaseRequestContext). Shared by the production
 * dispatcher (rsc/handler.ts) and the dispatch testing primitive. Throws
 * the site error for a mutation or a loader fetch, and RewriteLoopError.
 */
export function applyRewrite(
  rewrite: Rewrite,
  passRequest: Request,
  reqCtx: RequestContext<any>,
  routeMap: Record<string, string>,
  basename: string | undefined,
): RewritePass {
  if (passRequest.method !== "GET" && passRequest.method !== "HEAD") {
    throw rewriteNotSupported(rewrite, "mutation");
  }
  if (reqCtx.originalUrl.searchParams.has("_rsc_loader")) {
    throw rewriteNotSupported(rewrite, "loader-fetch");
  }
  const target = resolveRewriteTarget(rewrite, routeMap, reqCtx.url, basename);
  const hops = recordRewriteHop(reqCtx._variables, reqCtx.url, target);
  const url = rewriteTransportUrl(target, reqCtx.originalUrl);
  const request = new Request(url, passRequest);
  rebaseRequestContext(reqCtx, request, url);
  return { request, url, target, hops };
}
