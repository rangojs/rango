/**
 * `throw rewrite(target)`: middleware renders another route at the same URL.
 *
 * The value only: what middleware throws and how the router recognizes it.
 * The pass loop that honors it lives in rsc/rewrite-passes.ts, the hop trail
 * in server/rewrite-trail.ts.
 */

import type { GlobalReverseFunction } from "../reverse.js";
import type { DefaultReverseRouteMap } from "../types/global-namespace.js";

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
  "rewrite() is for middleware: throw it from router.use() or route " +
  "middleware (middleware() in urls()), before await next(), while it " +
  "handles a GET or HEAD page request. Loaders and route handlers can't " +
  "rewrite: throw rewrite() from the route's middleware instead. Middleware " +
  "in loader fetches can't either. In a server action use " +
  "redirect(); for a mutation return a Response from middleware.";

export function describeRewriteTarget(target: RewriteTarget): string {
  return "path" in target
    ? `rewrite(${JSON.stringify(target.path)})`
    : `rewrite(${JSON.stringify(target.name)})`;
}

/**
 * Which PPR shell a rewritten request reads and captures
 * (`rewrite(...).shell()`); without a call, none.
 * - `"visitor"`: its own, keyed by the visitor's URL and the target, captured
 *   with the visitor's location and `ctx.rewrittenFrom`.
 * - `"target"`: the target's shared shell. `usePathname()` reads the target's
 *   path on a HIT, and values set before the throw are baked in: for a page
 *   that renders neither (a lock or promo page).
 */
export type RewriteShell = "visitor" | "target";

/**
 * The value `rewrite()` returns, thrown by middleware. An Error, so a throw
 * where a rewrite is not supported fails loudly with the rule in its message.
 */
export class Rewrite extends Error {
  name = "Rewrite" as const;
  readonly target: RewriteTarget;
  /** The `shell()` choice; undefined: no shell. */
  readonly shellAudience: RewriteShell | undefined;

  constructor(target: RewriteTarget, shellAudience?: RewriteShell) {
    super(`${describeRewriteTarget(target)}: ${REWRITE_RULE}`);
    Object.setPrototypeOf(this, Rewrite.prototype);
    this.target = target;
    this.shellAudience = shellAudience;
  }

  /**
   * A copy that picks the PPR shell of a `ppr` target ({@link RewriteShell}),
   * so a rewrite kept in a module constant keeps its own choice:
   *
   * ```ts
   * throw rewrite("item", { id }).shell("visitor");
   * ```
   */
  shell(audience: RewriteShell): Rewrite {
    if (audience !== "visitor" && audience !== "target") {
      throw new TypeError(
        `${describeRewriteTarget(this.target)}.shell() takes "visitor" or "target", not ${JSON.stringify(audience)}.`,
      );
    }
    return new Rewrite(this.target, audience);
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
 * `rewrite(path)` or `rewrite(name, params?, search?)`: a path in this app
 * (basename-prefixed like `redirect()`, may carry `?search`), or a global
 * route name with the params and search `ctx.reverse` takes.
 */
export type RewriteFunction<TRoutes = DefaultReverseRouteMap> = ((
  path: `/${string}`,
) => Rewrite) &
  GlobalReverseFunction<TRoutes, Rewrite>;

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
 * Render another route at the same URL. Throw it from middleware, before
 * `await next()`:
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
 * visitor's URL. A `ppr` target gets no shell unless `.shell()` picks one
 * ({@link RewriteShell}). See the `/middleware` skill.
 */
export const rewrite: RewriteFunction = createRewrite as RewriteFunction;

/** A dispatch site that cannot honor a rewrite. */
export type RewriteSite = "mutation" | "loader-fetch";

const SITE_MESSAGE: Record<RewriteSite, string> = {
  mutation:
    "middleware threw it while handling a non-GET request (a server action " +
    "or a form post). Return a Response for mutations instead, e.g. " +
    'new Response("Maintenance", { status: 503 }).',
  "loader-fetch":
    "middleware threw it during a loader fetch (useFetchLoader, load(), " +
    "useRefreshLoaders). Return a Response there.",
};

/** The error a rewrite becomes at a site that cannot honor it. */
export function rewriteNotSupported(
  rewrite: Rewrite,
  site: RewriteSite,
): Error {
  return new Error(
    `${describeRewriteTarget(rewrite.target)} is not supported here: ${SITE_MESSAGE[site]}`,
    { cause: rewrite },
  );
}
