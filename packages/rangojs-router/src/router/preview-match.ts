import { loadManifest } from "./manifest.js";
import { traverseBack } from "./pattern-matching.js";
import { collectRouteMiddleware } from "./middleware.js";
import {
  parseAcceptTypes,
  RSC_RESPONSE_TYPE,
  pickNegotiateVariant,
} from "./content-negotiation.js";
import { runWithRouterLogContext, withRouterLogScope } from "./logging.js";
import type { EntryData } from "../server/context";
import type { RouteMatchResult } from "./pattern-matching.js";
import type { MiddlewareFn } from "./middleware.js";

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
} | null> {
  return runWithRouterLogContext(
    { request, transaction: "previewMatch" },
    async () =>
      withRouterLogScope("previewMatch", async () => {
        const url = new URL(request.url);
        const pathname = url.pathname;

        // Quick route matching
        const matched = deps.findMatch(pathname);
        if (!matched) {
          return null;
        }

        // Skip redirect check - will be handled in full match
        if (matched.redirectTo) {
          return { routeMiddleware: undefined };
        }

        // Load manifest (without segment resolution)
        const manifestEntry = await loadManifest(
          matched.entry,
          matched.routeKey,
          pathname,
          undefined, // No metrics store for preview
          false, // isSSR - doesn't matter for preview
        );

        // Collect route-level middleware from entry tree
        // Includes middleware from orphan layouts (inline layouts within routes)
        const routeMiddleware = collectRouteMiddleware(
          traverseBack(manifestEntry),
          matched.params,
        );

        // Check for response type (from trie match or manifest entry)
        const responseType =
          matched.responseType ||
          (manifestEntry.type === "route"
            ? manifestEntry.responseType
            : undefined);

        // Content negotiation: when negotiate variants exist, pick the best
        // handler based on the Accept header. Uses q-values and client order
        // as tiebreaker (matching Express/Hono behavior). RSC routes participate
        // as text/html candidates so browsers naturally get HTML without
        // special-casing.
        if (matched.negotiateVariants && matched.negotiateVariants.length > 0) {
          const acceptEntries = parseAcceptTypes(
            request.headers.get("accept") || "",
          );

          // Build candidate list preserving definition order.
          // For wildcard (*/*) and no-Accept fallback, the first candidate wins.
          const variants = matched.negotiateVariants;
          let candidates: Array<{ routeKey: string; responseType: string }>;
          if (responseType) {
            // Primary is response-type — include it as a candidate
            candidates = [
              ...variants,
              { routeKey: matched.routeKey, responseType },
            ];
          } else {
            // Primary is RSC — insert as text/html candidate in definition order
            const rscCandidate = {
              routeKey: matched.routeKey,
              responseType: RSC_RESPONSE_TYPE,
            };
            candidates = matched.rscFirst
              ? [rscCandidate, ...variants]
              : [...variants, rscCandidate];
          }

          const variant = pickNegotiateVariant(acceptEntries, candidates);

          // If the winner is RSC, fall through to default RSC handling
          if (variant.responseType === RSC_RESPONSE_TYPE) {
            // Fall through — RSC won negotiation
          } else if (responseType && variant.routeKey === matched.routeKey) {
            // Fall through — response-type primary won, already set
          } else {
            const negotiateEntry = await loadManifest(
              matched.entry,
              variant.routeKey,
              pathname,
              undefined,
              false,
            );
            return {
              routeMiddleware:
                routeMiddleware.length > 0 ? routeMiddleware : undefined,
              responseType: variant.responseType,
              handler:
                negotiateEntry.type === "route"
                  ? negotiateEntry.handler
                  : undefined,
              params: matched.params,
              negotiated: true,
              manifestEntry: negotiateEntry,
            };
          }
        }

        // If we passed through the negotiation block (variants exist), mark as
        // negotiated so the handler sets Vary: Accept on the response.
        const hasVariants =
          matched.negotiateVariants && matched.negotiateVariants.length > 0;
        return {
          routeMiddleware:
            routeMiddleware.length > 0 ? routeMiddleware : undefined,
          params: matched.params,
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
