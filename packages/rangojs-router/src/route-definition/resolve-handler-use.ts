import type { AllUseItems } from "../route-types.js";
import { isPrerenderHandler, isPassthroughHandler } from "../prerender.js";
import { isStaticHandler } from "../static-handler.js";

/**
 * Extract the .use callback from any handler shape.
 *
 * Checks definition brands first (objects with __brand), then plain functions.
 * ReactNode handlers return undefined (no .use possible).
 */
export function resolveHandlerUse(handler: unknown): (() => any[]) | undefined {
  if (handler == null) return undefined;

  // Check branded definitions first — they're objects but also have typeof "object"
  if (isPassthroughHandler(handler)) {
    return (handler as any).use;
  }
  if (isPrerenderHandler(handler)) {
    return (handler as any).use;
  }
  if (isStaticHandler(handler)) {
    return (handler as any).use;
  }
  // Plain handler function
  if (typeof handler === "function") {
    return (handler as any).use;
  }
  // ReactNode or other — no .use
  return undefined;
}

/**
 * Allowed item types per mount site.
 * Mirrors the RouteUseItem / ParallelUseItem / InterceptUseItem / LayoutUseItem unions
 * from route-types.ts for runtime validation.
 */
const MOUNT_SITE_ALLOWED_TYPES: Record<string, Set<string>> = {
  path: new Set([
    "layout",
    "parallel",
    "intercept",
    "middleware",
    "revalidate",
    "loader",
    "loading",
    "errorBoundary",
    "notFoundBoundary",
    "cache",
    "transition",
  ]),
  // Response routes (path.json, path.text, etc.) — mirrors ResponseRouteUseItem
  response: new Set(["middleware", "cache"]),
  route: new Set([
    "layout",
    "parallel",
    "intercept",
    "middleware",
    "revalidate",
    "loader",
    "loading",
    "errorBoundary",
    "notFoundBoundary",
    "cache",
    "transition",
  ]),
  // layout allows AllUseItems — no validation needed, but included for completeness
  layout: new Set([
    "layout",
    "route",
    "middleware",
    "revalidate",
    "parallel",
    "intercept",
    "loader",
    "loading",
    "errorBoundary",
    "notFoundBoundary",
    "cache",
    "transition",
    "include",
  ]),
  parallel: new Set([
    "revalidate",
    "loader",
    "loading",
    "errorBoundary",
    "notFoundBoundary",
    "transition",
  ]),
  intercept: new Set([
    "middleware",
    "revalidate",
    "loader",
    "loading",
    "errorBoundary",
    "notFoundBoundary",
    "layout",
    "route",
    "when",
    "transition",
  ]),
};

/**
 * Validate that items from handler.use() are valid for the given mount site.
 * Throws a descriptive error if any item is not allowed.
 */
export function validateHandlerUseItems(
  items: AllUseItems[],
  mountSite: string,
): void {
  const allowed = MOUNT_SITE_ALLOWED_TYPES[mountSite];
  if (!allowed) return;
  for (const item of items) {
    if (item == null) continue;
    if (!allowed.has((item as any).type)) {
      throw new Error(
        `handler.use() returned ${(item as any).type}() which is not valid inside ${mountSite}(). ` +
          `Allowed types: ${[...allowed].join(", ")}.`,
      );
    }
  }
}

/**
 * Create a merged use callback from handler.use and explicit use.
 * handler.use items come first (defaults), explicit items second (overrides).
 * Returns undefined if both are absent.
 */
export function mergeHandlerUse(
  handlerUse: (() => any[]) | undefined,
  explicitUse: (() => any[]) | undefined,
  mountSite: string,
): (() => any[]) | undefined {
  if (!handlerUse && !explicitUse) return undefined;
  if (!handlerUse) return explicitUse;
  if (!explicitUse) {
    return () => {
      const items = handlerUse().flat(3);
      validateHandlerUseItems(items, mountSite);
      return items;
    };
  }
  return () => {
    const hItems = handlerUse().flat(3);
    validateHandlerUseItems(hItems, mountSite);
    return [...hItems, ...explicitUse()];
  };
}
