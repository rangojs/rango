import { AsyncLocalStorage } from "node:async_hooks";
import type { ReactNode } from "react";
import type { PartialCacheOptions, ErrorBoundaryHandler, Handler, LoaderDefinition, MiddlewareFn, NotFoundBoundaryHandler, ShouldRevalidateFn } from "../types";
import { invariant } from "../errors";

// ============================================================================
//  Performance Metrics Types
// ============================================================================

/**
 * Performance metric entry for a single measured operation
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export interface PerformanceMetric {
  label: string;      // e.g., "route-matching", "loader:UserLoader"
  duration: number;   // milliseconds
  startTime: number;  // relative to request start
}

/**
 * Request-scoped metrics store
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export interface MetricsStore {
  enabled: boolean;
  requestStart: number;
  metrics: PerformanceMetric[];
}
// ============================================================================
//  RSC Router Context
// ============================================================================

/**
 * Cache configuration for an entry
 * When set, this entry and its children will use this cache config
 * unless overridden by a nested cache() call.
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export type EntryCacheConfig = {
  /** Cache options (false means caching disabled for this entry) - ttl is optional, uses defaults */
  options: PartialCacheOptions | false;
};

/**
 * Entry data structure for manifest
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export type EntryPropCommon = {
  id: string;
  shortCode: string; // Short identifier for network efficiency (e.g., "L0", "P1", "R2")
  parent: EntryData | null;
  /** Cache configuration for this entry (set by cache() DSL) */
  cache?: EntryCacheConfig;
  /** URL prefix from include() scope, used for MountContext on client */
  mountPath?: string;
};

/**
 * @internal This type is an implementation detail and may change without notice.
 */
export type EntryPropDatas = {
  middleware: MiddlewareFn<any, any>[];
  revalidate: ShouldRevalidateFn<any, any>[];
  errorBoundary: (ReactNode | ErrorBoundaryHandler)[];
  notFoundBoundary: (ReactNode | NotFoundBoundaryHandler)[];
};

/**
 * Loader entry stored in EntryData
 * Contains the loader definition and its revalidation rules
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export type LoaderEntry = {
  loader: LoaderDefinition<any>;
  revalidate: ShouldRevalidateFn<any, any>[];
  /** Cache config for this specific loader (loaders are NOT cached by default) */
  cache?: EntryCacheConfig;
};

/**
 * Segments state for intercept context
 * Matches the structure from useSegments() for consistency
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export type InterceptSegmentsState = {
  /** URL path segments (e.g., /shop/products/123 → ["shop", "products", "123"]) */
  path: readonly string[];
  /** Matched segment IDs in order (layouts and routes only, e.g., ["L0", "L0L1", "L0L1R0"]) */
  ids: readonly string[];
};

/**
 * Context passed to intercept selector functions (when())
 * Contains navigation context to determine if interception should occur.
 *
 * Note: when() is evaluated during route matching, BEFORE middleware runs.
 * So ctx.get()/ctx.use() are not available, but env (platform bindings) is.
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export type InterceptSelectorContext<TEnv = any> = {
  from: URL;                              // Source URL (where user is coming from)
  to: URL;                                // Destination URL (where user is navigating to)
  params: Record<string, string>;         // Matched route params
  request: Request;                       // The HTTP request object
  env: TEnv;                              // Platform bindings (Cloudflare env, etc.)
  segments: InterceptSegmentsState;       // Client's current segments (where navigating FROM)
};

/**
 * Selector function for conditional interception
 * Returns true to intercept, false to skip and fall through to route handler
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export type InterceptWhenFn<TEnv = any> = (ctx: InterceptSelectorContext<TEnv>) => boolean;

/**
 * Intercept entry stored in EntryData
 * Contains the slot name, route to intercept, and handler
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export type InterceptEntry = {
  slotName: `@${string}`;  // e.g., "@modal"
  routeName: string;        // e.g., "card"
  handler: ReactNode | Handler<any, any, any>;
  middleware: MiddlewareFn<any, any>[];
  revalidate: ShouldRevalidateFn<any, any>[];
  errorBoundary: (ReactNode | ErrorBoundaryHandler)[];
  notFoundBoundary: (ReactNode | NotFoundBoundaryHandler)[];
  loader: LoaderEntry[];
  loading?: ReactNode | false;
  layout?: ReactNode | Handler<any, any, any>;  // Wrapper layout with <Outlet /> for content
  when: InterceptWhenFn[];  // Selector conditions - all must return true to intercept
};

export type EntryPropSegments = {
  loader: LoaderEntry[];
  layout: EntryData[];
  parallel: EntryData[]; // type: "parallel" entries with their own loaders/revalidate/loading
  intercept: InterceptEntry[]; // intercept definitions for soft navigation
};

export type EntryData =
  | ({
      type: "route";
      handler: Handler<any, any, any>;
      loading?: ReactNode | false;
      /** URL pattern for this route (used by path() in urls()) */
      pattern?: string;
      /** Set when handler is a Prerender definition */
      isPrerender?: true;
      /** Original PrerenderHandlerDefinition (for build-time getParams access) */
      prerenderDef?: { getParams?: () => Promise<any[]> | any[]; options?: { passthrough?: boolean } };
      /** Set when handler is a Static definition (build-time only) */
      isStaticPrerender?: true;
      /** Response type for non-RSC routes (json, text, image, any) */
      responseType?: string;
    } & EntryPropCommon &
      EntryPropDatas &
      EntryPropSegments)
  | ({
      type: "layout";
      handler: ReactNode | Handler<any, any, any>;
      loading?: ReactNode | false;
      /** Set when handler is a Static definition (build-time only) */
      isStaticPrerender?: true;
    } & EntryPropCommon &
      EntryPropDatas &
      EntryPropSegments)
  | ({
      type: "parallel";
      handler: Record<`@${string}`, Handler<any, any, any> | ReactNode>;
      loading?: ReactNode | false;
      /** Set when any parallel slot is a Static definition */
      isStaticPrerender?: true;
    } & EntryPropCommon &
      EntryPropDatas &
      EntryPropSegments)
  | ({
      type: "cache";
      /** Cache entries create cache boundaries and render like layouts (with Outlet) */
      handler: ReactNode | Handler<any, any, any>;
      loading?: ReactNode | false;
    } & EntryPropCommon &
      EntryPropDatas &
      EntryPropSegments);

/**
 * Tracked include info for build-time manifest generation
 */
export interface TrackedInclude {
  prefix: string;
  fullPrefix: string;
  namePrefix?: string;
  patterns: unknown; // UrlPatterns
  lazy: boolean;
}

/**
 * Context stored in AsyncLocalStorage
 */
interface HelperContext {
  manifest: Map<string, EntryData>;
  namespace: string;
  parent: EntryData | null;
  counters: Record<string, number>;
  forRoute?: string;
  mountIndex?: number;
  metrics?: MetricsStore;
  /** True when rendering for SSR (document requests) */
  isSSR?: boolean;
  /** URL patterns map for path() routes (route name -> pattern) */
  patterns?: Map<string, string>;
  /** URL patterns grouped by include prefix for separate entry creation */
  patternsByPrefix?: Map<string, Map<string, string>>;
  /** Trailing slash config per route name */
  trailingSlash?: Map<string, "never" | "always" | "ignore">;
  /** Search param schemas per route name */
  searchSchemas?: Map<string, Record<string, string>>;
  /** URL prefix from include() - applied to all path() patterns */
  urlPrefix?: string;
  /** Name prefix from include() - applied to all named routes */
  namePrefix?: string;
  /** Run helper for cleaner middleware code */
  run?: <T>(fn: () => T | Promise<T>) => T | Promise<T>;
  /** Tracked includes for build-time manifest generation */
  trackedIncludes?: TrackedInclude[];
}
export const RSCRouterContext: AsyncLocalStorage<HelperContext> =
  new AsyncLocalStorage<HelperContext>();

export const getContext = (): {
  context: AsyncLocalStorage<HelperContext>;
  getStore: () => HelperContext;
  getParent: () => EntryData | null;
  getOrCreateStore: (forRoute?: string) => HelperContext;
  getNextIndex: (
    type: (string & {}) | "layout" | "parallel" | "middleware" | "revalidate"
  ) => string;
  getShortCode: (
    type: "layout" | "parallel" | "route" | "loader" | "cache"
  ) => string;
  run: <T>(
    namespace: string,
    parent: EntryData | null,
    callback: (...args: any[]) => T
  ) => T;
  runWithStore: <T>(
    store: HelperContext,
    namespace: string,
    parent: EntryData | null,
    callback: (...args: any[]) => T
  ) => T;
} => {
  const context = RSCRouterContext;

  return {
    context,
    getOrCreateStore: (forRoute?: string): HelperContext => {
      let store = RSCRouterContext.getStore();
      if (!store) {
        store = {
          manifest: new Map<string, EntryData>(),
          namespace: "",
          parent: null,
          forRoute,
          counters: {},
          patterns: new Map<string, string>(),
          patternsByPrefix: new Map<string, Map<string, string>>(),
          trailingSlash: new Map<string, "never" | "always" | "ignore">(),
          searchSchemas: new Map<string, Record<string, string>>(),
        } satisfies HelperContext;
      }
      return store;
    },
    getStore: (): HelperContext => {
      const store = context.getStore();
      if (!store) {
        throw new Error(
          "RSC Router context store is not available. Make sure to run within RSC Router context."
        );
      }
      return store;
    },
    getParent: (): EntryData | null => {
      const store = context.getStore();
      if (!store) {
        return null;
      }

      return store.parent;
    },
    getNextIndex: (
      type: (string & {}) | "layout" | "parallel" | "middleware" | "revalidate"
    ) => {
      const store = context.getStore();
      invariant(store, "No context RSCRouterContext available");
      store.counters[type] ??= 0;
      const index = store.counters[type];
      store.counters[type] = index + 1;
      return `$${type}.${index}`;
    },
    getShortCode: (type: "layout" | "parallel" | "route" | "loader" | "cache") => {
      const store = context.getStore();
      invariant(store, "No context RSCRouterContext available");

      const parent = store.parent;
      const prefix = type === "layout" ? "L" : type === "parallel" ? "P" : type === "loader" ? "D" : type === "cache" ? "C" : "R";
      const mountPrefix = store.mountIndex !== undefined ? `M${store.mountIndex}` : "";

      if (!parent) {
        // Root entry: prefix with mount index and use mount-scoped counter
        const counterKey = mountPrefix ? `${mountPrefix}_root_${type}` : `root_${type}`;
        store.counters[counterKey] ??= 0;
        const index = store.counters[counterKey];
        store.counters[counterKey] = index + 1;
        return `${mountPrefix}${prefix}${index}`;
      } else {
        // Child entry: use parent-scoped counter (parent already has M prefix)
        const counterKey = `${parent.shortCode}_${type}`;
        store.counters[counterKey] ??= 0;
        const index = store.counters[counterKey];
        store.counters[counterKey] = index + 1;
        return `${parent.shortCode}${prefix}${index}`;
      }
    },
    runWithStore: <T>(
      store: HelperContext,
      namespace: string,
      parent: EntryData | null,
      callback: (...args: any[]) => T
    ): T => {
      return context.run(
        {
          manifest: store.manifest,
          namespace,
          parent: parent || null,
          counters: store.counters,
          forRoute: store.forRoute,
          mountIndex: store.mountIndex,
          metrics: store.metrics,
          isSSR: store.isSSR,
          patterns: store.patterns,
          trailingSlash: store.trailingSlash,
          searchSchemas: store.searchSchemas,
          urlPrefix: store.urlPrefix,
          namePrefix: store.namePrefix,
          trackedIncludes: store.trackedIncludes,
        },
        callback
      );
    },
    run: <T>(
      namespace: string,
      parent: EntryData | null,
      callback: (...args: any[]) => T
    ) => {
      const store = context.getStore();
      // Preserve parent counters to ensure globally unique shortCodes
      const counters = store?.counters || {};
      const manifest = store ? store.manifest : new Map<string, EntryData>();
      const patterns = store?.patterns || new Map<string, string>();
      const trailingSlash = store?.trailingSlash || new Map<string, "never" | "always" | "ignore">();
      const searchSchemas = store?.searchSchemas || new Map<string, Record<string, string>>();
      return context.run(
        {
          manifest,
          namespace,
          parent: parent || null,
          counters,
          forRoute: store?.forRoute,
          mountIndex: store?.mountIndex,
          metrics: store?.metrics,
          isSSR: store?.isSSR,
          patterns,
          trailingSlash,
          searchSchemas,
          urlPrefix: store?.urlPrefix,
          namePrefix: store?.namePrefix,
          trackedIncludes: store?.trackedIncludes,
        },
        callback
      );
    },
  };
};

/**
 * Run a callback with specific URL and name prefixes
 * Used by include() to apply prefixes to nested patterns
 */
export function runWithPrefixes<T>(
  urlPrefix: string,
  namePrefix: string | undefined,
  callback: () => T
): T {
  const store = RSCRouterContext.getStore();
  if (!store) {
    throw new Error("runWithPrefixes must be called within router context");
  }

  // Combine prefixes if there are existing ones, avoiding double slashes
  let combinedUrlPrefix: string;
  if (store.urlPrefix) {
    if (store.urlPrefix.endsWith("/") && urlPrefix.startsWith("/")) {
      combinedUrlPrefix = store.urlPrefix + urlPrefix.slice(1);
    } else {
      combinedUrlPrefix = store.urlPrefix + urlPrefix;
    }
  } else {
    combinedUrlPrefix = urlPrefix;
  }
  const combinedNamePrefix = namePrefix
    ? store.namePrefix
      ? `${store.namePrefix}.${namePrefix}`
      : namePrefix
    : store.namePrefix;

  return RSCRouterContext.run(
    {
      ...store,
      urlPrefix: combinedUrlPrefix,
      namePrefix: combinedNamePrefix,
    },
    callback
  );
}

/**
 * Get current URL prefix from context
 */
export function getUrlPrefix(): string {
  const store = RSCRouterContext.getStore();
  return store?.urlPrefix || "";
}

/**
 * Get current name prefix from context
 */
export function getNamePrefix(): string | undefined {
  const store = RSCRouterContext.getStore();
  return store?.namePrefix;
}

// Export HelperContext type for use in other modules
export type { HelperContext };

// ============================================================================
//  Performance Metrics Helpers
// ============================================================================

/**
 * Track performance of a code block (no-op if metrics not enabled)
 * Returns a done() callback to mark completion and record duration
 *
 * @example
 * ```typescript
 * const done = track("route-matching");
 * // ... do work ...
 * done(); // Records duration
 * ```
 */
export function track(label: string): () => void {
  const store = RSCRouterContext.getStore();

  // No-op if context unavailable or metrics not enabled
  if (!store?.metrics?.enabled) {
    return () => {};
  }

  const startTime = performance.now() - store.metrics.requestStart;

  return () => {
    const duration = performance.now() - store.metrics!.requestStart - startTime;
    store.metrics!.metrics.push({ label, duration, startTime });
  };
}
