import { negotiateRoute } from "./content-negotiation.js";
import { runWithRouterLogContext, withRouterLogScope } from "./logging.js";
import type { RouteMatchResult } from "./pattern-matching.js";
import type { MiddlewareFn } from "./middleware.js";
import { resolveRoute } from "./route-snapshot.js";

export interface PreviewMatchDeps<TEnv = any> {
  findMatch: (
    pathname: string,
  ) => RouteMatchResult<TEnv> | null | Promise<RouteMatchResult<TEnv> | null>;
}

/**
 * Preview match - returns the route, its params and route middleware without
 * segment resolution (a content-negotiated variant's, when one wins).
 */
export async function previewMatch<TEnv = any>(
  request: Request,
  _context: TEnv,
  deps: PreviewMatchDeps<TEnv>,
): Promise<{
  routeMiddleware?: Array<{
    handler: MiddlewareFn;
    params: Record<string, string>;
  }>;
  params?: Record<string, string>;
  routeKey?: string;
} | null> {
  return runWithRouterLogContext(
    { request, transaction: "previewMatch" },
    async () =>
      withRouterLogScope("previewMatch", async () => {
        const url = new URL(request.url);
        const pathname = url.pathname;

        // Route resolution via snapshot (lite mode: skip entries/cacheScope
        // since previewMatch only needs matched, manifestEntry, routeMiddleware,
        // and responseType)
        const result = await resolveRoute<TEnv>(pathname, {
          findMatch: deps.findMatch,
          lite: true,
        });

        if (!result) {
          return null;
        }

        // Skip redirect check - will be handled in full match
        if (result.type === "redirect") {
          return { routeMiddleware: undefined };
        }

        const snapshot = result.snapshot;
        const { matched } = snapshot;
        // A winning response variant brings its own route middleware.
        const negotiation = await negotiateRoute(request, pathname, snapshot);
        const routeMiddleware =
          negotiation?.routeMiddleware ?? snapshot.routeMiddleware;
        return {
          routeMiddleware:
            routeMiddleware.length > 0 ? routeMiddleware : undefined,
          params: matched.params,
          routeKey: matched.routeKey,
        };
      }),
  );
}
