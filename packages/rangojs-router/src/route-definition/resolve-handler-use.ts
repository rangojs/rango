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
  // Loader definitions from createLoader() — branded objects with optional .use
  if (typeof handler === "object" && (handler as any).__brand === "loader") {
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
  // intercept() checks its whole merged use() (explicit and handler.use)
  // against this set via validateInterceptUseItems below.
  intercept: new Set([
    "middleware",
    "loader",
    "loading",
    "layout",
    "route",
    "transition",
  ]),
  // LoaderUseItem — only revalidate + cache can attach to a loader entry
  loader: new Set(["revalidate", "cache"]),
};

const INTERCEPT_BOUNDARY_HINT =
  "put it on the enclosing layout or path; it handles the intercept's handler and loader errors";

/**
 * Where each item intercept() rejects goes instead. Why an intercept cannot
 * hold them is documented at intercept() in dsl-helpers.ts.
 */
const INTERCEPT_REJECTION_HINTS: Record<string, string> = {
  revalidate:
    "attach it to the intercept's loader: loader(YourLoader, () => [revalidate(...)])",
  errorBoundary: INTERCEPT_BOUNDARY_HINT,
  notFoundBoundary: INTERCEPT_BOUNDARY_HINT,
  cache:
    'put cache() on the target route (intercept navigations get their own "intercept:" cache key) or use "use cache" in the handler',
};

function rejectInterceptItem(
  what: string,
  hint: string,
  slotName: string,
  routeName: string,
): never {
  throw new Error(
    `${what} is not valid inside intercept("${slotName}", "${routeName}") use() (including the handler's .use): ${hint}.`,
  );
}

/**
 * Validate every item an intercept's merged use() returned (explicit use()
 * and handler.use) against MOUNT_SITE_ALLOWED_TYPES.intercept, plus two
 * structural rules:
 * - a nested layout() is only the modal chrome (intercept() keeps its
 *   handler), so it may not carry use() items of its own;
 * - a cache entry in `capturedLayouts` means cache() ran in the scope even if
 *   it was not returned; its orphan form re-parents the following siblings
 *   onto that entry, so it is rejected the same way. Inside a path, cache()
 *   writes `sinks.cache` instead (dsl-helpers.ts cache()).
 */
export function validateInterceptUseItems(
  items: AllUseItems[],
  capturedLayouts: readonly { type: string }[],
  slotName: string,
  routeName: string,
  sinks: {
    readonly revalidate: readonly unknown[];
    readonly errorBoundary: readonly unknown[];
    readonly notFoundBoundary: readonly unknown[];
    readonly intercept: readonly unknown[];
    readonly parallel: Readonly<Record<string, unknown>>;
    /** Set by cache() when the intercept is declared inside a path. */
    readonly cache?: unknown;
  },
): void {
  const allowed = MOUNT_SITE_ALLOWED_TYPES.intercept!;
  for (const item of items) {
    if (item == null) continue;
    const type = (item as { type: string }).type;
    if (!allowed.has(type)) {
      rejectInterceptItem(
        `${type}()`,
        INTERCEPT_REJECTION_HINTS[type] ??
          `allowed items are ${[...allowed].join(", ")}`,
        slotName,
        routeName,
      );
    }
    if (type === "layout" && (item as { uses?: unknown[] }).uses?.length) {
      rejectInterceptItem(
        "layout() with its own use() items",
        "put the modal chrome in the layout component and attach loaders to the intercept itself",
        slotName,
        routeName,
      );
    }
  }
  // A rejected helper called without being returned still wrote into its
  // throwaway field on the temporary parent; reject it the same way.
  for (const type of [
    "revalidate",
    "errorBoundary",
    "notFoundBoundary",
    "intercept",
  ] as const) {
    if (sinks[type].length > 0) {
      rejectInterceptItem(
        `${type}()`,
        INTERCEPT_REJECTION_HINTS[type] ??
          `allowed items are ${[...allowed].join(", ")}`,
        slotName,
        routeName,
      );
    }
  }
  if (Object.keys(sinks.parallel).length > 0) {
    rejectInterceptItem(
      "parallel()",
      `allowed items are ${[...allowed].join(", ")}`,
      slotName,
      routeName,
    );
  }
  if (
    capturedLayouts.some((l) => l.type === "cache") ||
    sinks.cache !== undefined
  ) {
    rejectInterceptItem(
      "cache()",
      INTERCEPT_REJECTION_HINTS.cache!,
      slotName,
      routeName,
    );
  }
}

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
  mountSite: string | null,
): (() => any[]) | undefined {
  if (!handlerUse && !explicitUse) return undefined;
  // Validation asymmetry (intentional, pre-1.0): only handler.use() items are
  // checked against the mount-site allow-list (validateHandlerUseItems below).
  // Explicit use() items pass through unvalidated on both the explicit-only
  // branch here and the merged branch, so a structurally-valid-but-prohibited
  // item (e.g. middleware() inside a parallel slot) is not rejected at this seam.
  // Documented rather than enforced for now; revisit before 1.0 (#569).
  // intercept() is the exception: it passes mountSite null and validates the
  // merged items itself (validateInterceptUseItems).
  if (!handlerUse) return explicitUse;
  if (!explicitUse) {
    return () => {
      const items = handlerUse().flat(3);
      if (mountSite) validateHandlerUseItems(items, mountSite);
      return items;
    };
  }
  return () => {
    const hItems = handlerUse().flat(3);
    if (mountSite) validateHandlerUseItems(hItems, mountSite);
    return [...hItems, ...explicitUse()];
  };
}
