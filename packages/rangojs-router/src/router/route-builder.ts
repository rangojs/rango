import { registerRouteMap } from "../route-map-builder.js";
import { extractStaticPrefix } from "./pattern-matching.js";
import type { AllUseItems } from "../route-types.js";
import type {
  ResolvedRouteMap,
  RouteDefinition,
  RouteEntry,
  TrailingSlashMode,
} from "../types";
import type { MiddlewareFn } from "./middleware.js";
import type {
  RSCRouter,
  RouteBuilder,
  InlineRouteHelpers,
} from "./router-interfaces.js";

export interface RouteBuilderDeps<TEnv = any> {
  mergedRouteMap: Record<string, string>;
  routesEntries: RouteEntry<TEnv>[];
  addMiddleware: (
    patternOrMiddleware: string | MiddlewareFn<TEnv>,
    middleware?: MiddlewareFn<TEnv>,
    mountPrefix?: string | null,
  ) => void;
  router: RSCRouter<TEnv, any>;
}

/**
 * Create route builder with accumulated route types.
 * The TNewRoutes type parameter captures the new routes being added.
 */
export function createRouteBuilder<
  TEnv = any,
  TNewRoutes extends Record<string, string> = Record<string, string>,
>(
  prefix: string,
  routes: TNewRoutes,
  currentMountIndex: number,
  deps: RouteBuilderDeps<TEnv>,
): RouteBuilder<RouteDefinition, TEnv, any, TNewRoutes> {
  const { mergedRouteMap, routesEntries, addMiddleware, router } = deps;

  // Merge routes into the reverse map
  // Keys stay unchanged for composability - only URL patterns get prefixed
  if (routes == null) {
    throw new Error(
      `[rsc-router] createRouteBuilder received null/undefined routes for prefix "${prefix}". ` +
        `This is an invariant violation — the route builder callback must return a Record<string, string>.`,
    );
  }
  const routeEntries = routes as Record<string, string>;
  for (const [key, pattern] of Object.entries(routeEntries)) {
    // Build prefixed pattern: "/shop" + "/cart" -> "/shop/cart"
    // Root prefix "/" is a no-op — don't double the leading slash.
    const effectivePrefix = prefix === "/" ? "" : prefix;
    const prefixedPattern =
      effectivePrefix && pattern !== "/"
        ? `${effectivePrefix}${pattern}`
        : effectivePrefix && pattern === "/"
          ? effectivePrefix
          : pattern;

    // Runtime validation: warn if key already exists with different pattern
    const existingPattern = mergedRouteMap[key];
    if (existingPattern !== undefined && existingPattern !== prefixedPattern) {
      console.warn(
        `[rsc-router] Route key conflict: "${key}" already maps to "${existingPattern}", ` +
          `overwriting with "${prefixedPattern}". Use unique key names to avoid this.`,
      );
    }

    // Use original key - enables reusable route modules
    mergedRouteMap[key] = prefixedPattern;
  }

  // Auto-register route map for runtime reverse() usage
  registerRouteMap(mergedRouteMap);

  // Extract trailing slash config if present (attached by route())
  const trailingSlashConfig = (routes as any).__trailingSlash as
    | Record<string, TrailingSlashMode>
    | undefined;

  // Create builder object so .use() can return it
  const builder: RouteBuilder<RouteDefinition, TEnv, any, TNewRoutes> = {
    use(
      patternOrMiddleware: string | MiddlewareFn<TEnv>,
      middleware?: MiddlewareFn<TEnv>,
    ) {
      // Mount-scoped middleware - prefix is the mount prefix
      addMiddleware(patternOrMiddleware, middleware, prefix || null);
      return builder;
    },

    map(
      handler:
        | ((
            helpers: InlineRouteHelpers<TNewRoutes, TEnv>,
          ) => Array<AllUseItems>)
        | (() =>
            | Array<AllUseItems>
            | Promise<{ default: () => Array<AllUseItems> }>
            | Promise<() => Array<AllUseItems>>),
    ) {
      // Store handler as-is - detection happens at call time based on return type
      // Both patterns use the same signature:
      // - Inline: ({ route }) => [...] - receives helpers, returns Array
      // - Lazy: () => import(...) - ignores helpers, returns Promise
      routesEntries.push({
        prefix,
        staticPrefix: extractStaticPrefix(prefix),
        routes: routes as ResolvedRouteMap<any>,
        trailingSlash: trailingSlashConfig,
        handler: handler as any,
        mountIndex: currentMountIndex,
      });
      // Return router with accumulated types
      // At runtime this is the same object, but TypeScript tracks the accumulated route types
      return router as any;
    },

    // Expose accumulated route map for typeof extraction
    get routeMap() {
      return mergedRouteMap as TNewRoutes;
    },
  };

  return builder;
}
