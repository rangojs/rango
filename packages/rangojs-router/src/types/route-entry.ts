import type { AllUseItems } from "../route-types.js";
import type { TrailingSlashMode, ResolvedRouteMap } from "./route-config.js";

/**
 * Context captured for lazy include evaluation
 */
export interface LazyIncludeContext {
  urlPrefix: string;
  namePrefix: string | undefined;
  parent: unknown; // EntryData - avoid circular import
}

/**
 * Internal route entry stored in router
 */
export interface RouteEntry<TEnv = any> {
  prefix: string;
  /**
   * Pre-computed static prefix for fast short-circuit matching.
   * Extracted from prefix at registration time (everything before first param).
   *
   * Examples:
   * - "/api" -> staticPrefix = "/api"
   * - "/site/:locale" -> staticPrefix = "/site"
   * - "/:locale" -> staticPrefix = "" (empty, can't optimize)
   *
   * At runtime: if staticPrefix && !pathname.startsWith(staticPrefix), skip entry.
   */
  staticPrefix: string;
  /**
   * Route patterns map. For lazy entries, this starts as empty and is
   * populated on first request.
   */
  routes: ResolvedRouteMap<any>;
  /**
   * Trailing slash config per route key
   * If not specified for a route, defaults to pattern-based detection
   */
  trailingSlash?: Record<string, TrailingSlashMode>;
  handler: () =>
    | Array<AllUseItems>
    | Promise<{ default: () => Array<AllUseItems> }>
    | Promise<() => Array<AllUseItems>>;
  mountIndex: number;

  /**
   * Route keys in this entry that have pre-render handlers.
   * Used by the non-trie match path to set the `pr` flag.
   */
  prerenderRouteKeys?: Set<string>;

  // === Lazy evaluation fields ===

  /**
   * Whether this entry is lazily evaluated.
   * When true, routes are populated on first matching request.
   */
  lazy?: boolean;

  /**
   * For lazy entries: the UrlPatterns to evaluate
   */
  lazyPatterns?: unknown;

  /**
   * For lazy entries: captured context at definition time
   */
  lazyContext?: LazyIncludeContext;

  /**
   * For lazy entries: whether patterns have been evaluated
   */
  lazyEvaluated?: boolean;
}
