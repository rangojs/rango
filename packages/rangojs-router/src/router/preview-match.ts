import { negotiateRoute } from "./content-negotiation.js";
import { runWithRouterLogContext, withRouterLogScope } from "./logging.js";
import type { EntryData } from "../server/context";
import type { RouteMatchResult } from "./pattern-matching.js";
import type { MiddlewareFn } from "./middleware.js";
import { resolveRoute } from "./route-snapshot.js";

export interface PreviewMatchDeps<TEnv = any> {
  findMatch: (pathname: string) => RouteMatchResult<TEnv> | null;
}

/**
 * Preview match - returns route middleware without segment resolution.
 * Also returns responseType and handler for response routes (non-RSC short-circuit).
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
  responseType?: string;
  handler?: Function;
  params?: Record<string, string>;
  negotiated?: boolean;
  manifestEntry?: EntryData;
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
        const { matched, manifestEntry, routeMiddleware, responseType } =
          snapshot;

        // Content negotiation via shared helper
        const negotiation = await negotiateRoute(
          request,
          pathname,
          matched,
          manifestEntry,
          responseType,
          routeMiddleware,
        );
        if (negotiation) {
          return {
            routeMiddleware:
              negotiation.routeMiddleware.length > 0
                ? negotiation.routeMiddleware
                : undefined,
            responseType: negotiation.responseType,
            handler: negotiation.handler,
            params: matched.params,
            negotiated: true,
            manifestEntry: negotiation.manifestEntry,
            routeKey: matched.routeKey,
          };
        }

        // No negotiation or RSC won — return default route info
        const hasVariants =
          matched.negotiateVariants && matched.negotiateVariants.length > 0;
        return {
          routeMiddleware:
            routeMiddleware.length > 0 ? routeMiddleware : undefined,
          params: matched.params,
          routeKey: matched.routeKey,
          ...(responseType
            ? {
                responseType,
                handler:
                  manifestEntry.type === "route"
                    ? manifestEntry.handler
                    : undefined,
                manifestEntry,
              }
            : {}),
          ...(hasVariants ? { negotiated: true } : {}),
        };
      }),
  );
}
