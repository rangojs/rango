import type { AllUseItems } from "../route-types.js";
import type { TrailingSlashMode, ResolvedRouteMap } from "./route-config.js";

export interface LazyIncludeContext {
  urlPrefix: string;
  namePrefix: string | undefined;
  parent: unknown; // EntryData - avoid circular import
  /** Counter snapshot from pattern extraction for consistent shortCode indices */
  counters?: Record<string, number>;
  cacheProfiles?: Record<
    string,
    import("../cache/profile-registry.js").CacheProfile
  >;
  /** Root scope flag for dot-local reverse resolution */
  rootScoped?: boolean;
  /** Owning router id; scopes search-schema/root-scope registration during
   *  lazy include evaluation (route-map-builder.ts registries) */
  routerId?: string;
  /**
   * Positional include scope token composed from the parent scope plus this
   * include's sibling index (`${parentScope}I${idx}`). Applied to direct-
   * descendant shortCodes during lazy evaluation so routes inside the
   * include cannot collide with siblings declared outside it.
   */
  includeScope?: string;
}

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
  /**
   * Supported handler shapes:
   *   - sync: () => Array<AllUseItems>
   *   - lazy import: () => Promise<{ default: () => Array<AllUseItems> }>
   *   - lazy function: () => Promise<() => Array<AllUseItems>>
   *
   * Direct Promise<Array> is NOT supported and rejected at runtime.
   */
  handler: () =>
    | Array<AllUseItems>
    | Promise<{ default: () => Array<AllUseItems> }>
    | Promise<() => Array<AllUseItems>>;
  mountIndex: number;

  /**
   * Router ID that owns this entry. Used to namespace the manifest cache
   * so multi-router setups (host routing) don't share cached EntryData
   * across routers with overlapping mountIndex + routeKey combinations.
   */
  routerId?: string;

  /**
   * Route keys in this entry that have pre-render handlers.
   * Used by the non-trie match path to set the `pr` flag.
   */
  prerenderRouteKeys?: Set<string>;

  /**
   * Route keys in this entry that are wrapped with `Passthrough()`.
   * Used by the non-trie match path to set the `pt` flag.
   */
  passthroughRouteKeys?: Set<string>;

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

  /**
   * Cache profiles for DSL-time cache("profileName") resolution.
   * Set on all entries (lazy and non-lazy) so loadManifest() can
   * propagate them into the HelperContext Store.
   */
  cacheProfiles?: Record<
    string,
    import("../cache/profile-registry.js").CacheProfile
  >;
}
