import { AsyncLocalStorage } from "node:async_hooks";
import type { ReactNode } from "react";
import type {
  PartialCacheOptions,
  ErrorBoundaryHandler,
  Handler,
  LoaderDefinition,
  MiddlewareFn,
  NotFoundBoundaryHandler,
  ShouldRevalidateFn,
  TransitionConfig,
} from "../types";
import { invariant, DslContextError } from "../errors";
import type { DefaultRouteName } from "../types/global-namespace.js";

// ============================================================================
//  Performance Metrics Types
// ============================================================================

/**
 * Performance metric entry for a single measured operation
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export interface PerformanceMetric {
  label: string; // e.g., "route-matching", "loader:UserLoader"
  duration: number; // milliseconds
  startTime: number; // relative to request start
  depth?: number; // nesting level for hierarchical display (0 = top-level)
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
//  Rango Context
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
 * Attachments resolved by walking the parent chain, not owned by the entry:
 * middleware composes downward; revalidate and the error/notFound boundaries are
 * resolved by nearest-ancestor lookup. Inherited, not a single execution chain.
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export type EntryPropDatas = {
  middleware: MiddlewareFn<any, any>[];
  revalidate: ShouldRevalidateFn<any, any>[];
  errorBoundary: (ReactNode | ErrorBoundaryHandler)[];
  notFoundBoundary: (ReactNode | NotFoundBoundaryHandler)[];
};

/**
 * Render-time presentation fields shared by every entry variant.
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export type EntryPropRender = {
  loading?: ReactNode | false;
  transition?: TransitionConfig;
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
  from: URL; // Source URL (where user is coming from)
  to: URL; // Destination URL (where user is navigating to)
  params: Record<string, string>; // Matched route params
  request: Request; // The HTTP request object
  env: TEnv; // Platform bindings (Cloudflare env, etc.)
  segments: InterceptSegmentsState; // Client's current segments (where navigating FROM)
  fromRouteName?: DefaultRouteName; // Named route being navigated away from (undefined for unnamed routes)
  toRouteName?: DefaultRouteName; // Named route being navigated to (undefined for unnamed routes)
};

/**
 * Selector function for conditional interception
 * Returns true to intercept, false to skip and fall through to route handler
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export type InterceptWhenFn<TEnv = any> = (
  ctx: InterceptSelectorContext<TEnv>,
) => boolean;

/**
 * Config object passed to intercept() (its 4th argument). `when` gates whether
 * the intercept activates on a soft navigation — a single match-time selector or
 * an array of them (ALL must return true; omit to always activate). This is the
 * intercept counterpart to transition({ when }); both express conditional
 * behavior as a config field rather than a separate DSL helper.
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export interface InterceptConfig<TEnv = any> {
  when?: InterceptWhenFn<TEnv> | InterceptWhenFn<TEnv>[];
}

/**
 * Intercept entry stored in EntryData
 * Contains the slot name, route to intercept, and handler
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export type InterceptEntry = {
  slotName: `@${string}`; // e.g., "@modal"
  routeName: string; // e.g., "card"
  handler: ReactNode | Handler<any, any, any>;
  middleware: MiddlewareFn<any, any>[];
  revalidate: ShouldRevalidateFn<any, any>[];
  errorBoundary: (ReactNode | ErrorBoundaryHandler)[];
  notFoundBoundary: (ReactNode | NotFoundBoundaryHandler)[];
  loader: LoaderEntry[];
  loading?: ReactNode | false;
  transition?: TransitionConfig;
  layout?: ReactNode | Handler<any, any, any>; // Wrapper layout with <Outlet /> for content
  when: InterceptWhenFn[]; // Selector conditions - all must return true to intercept
};

export interface ParallelEntryData
  extends EntryPropCommon, EntryPropDatas, EntryPropSegments, EntryPropRender {
  type: "parallel";
  handler: Record<`@${string}`, Handler<any, any, any> | ReactNode>;
  /** Set when any parallel slot is a Static definition */
  isStaticPrerender?: true;
  /** Per-slot static handler $$ids for build-time store lookup */
  staticHandlerIds?: Record<string, string>;
}

export type ParallelEntries = Partial<Record<`@${string}`, ParallelEntryData>>;

/**
 * This entry's own structural children plus its owned loaders. `loader` lives
 * here (not in EntryPropDatas) because loaders are owned by the entry, not
 * inherited from ancestors.
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export type EntryPropSegments = {
  loader: LoaderEntry[];
  layout: EntryData[];
  parallel: ParallelEntries; // slot -> parallel entry (same entry may back multiple slots)
  intercept: InterceptEntry[]; // intercept definitions for soft navigation
};

export type EntryData =
  | ({
      type: "route";
      handler: Handler<any, any, any>;
      /** URL pattern for this route (used by path() in urls()) */
      pattern?: string;
      /** Set when handler is a Prerender definition */
      isPrerender?: true;
      /** Original PrerenderHandlerDefinition (for build-time getParams access) */
      prerenderDef?: {
        getParams?: (ctx: any) => Promise<any[]> | any[];
        options?: {
          concurrency?: number;
          onDemand?: import("../prerender/on-demand.js").OnDemandOption;
        };
      };
      /** Set when the route opted into on-demand prerender (Prerender(..., { onDemand })) */
      isOnDemand?: true;
      /** Set when route is wrapped with Passthrough() — has a separate live handler */
      isPassthrough?: true;
      /** Live handler for runtime fallback (only set on Passthrough routes) */
      liveHandler?: Handler<any, any, any>;
      /** Set when handler is a Static definition (build-time only) */
      isStaticPrerender?: true;
      /** Static handler $$id for build-time store lookup */
      staticHandlerId?: string;
      /** Response type for non-RSC routes (json, text, image, any) */
      responseType?: string;
    } & EntryPropCommon &
      EntryPropDatas &
      EntryPropSegments &
      EntryPropRender)
  | ({
      type: "layout";
      handler: ReactNode | Handler<any, any, any>;
      /** Set when handler is a Static definition (build-time only) */
      isStaticPrerender?: true;
      /** Static handler $$id for build-time store lookup */
      staticHandlerId?: string;
    } & EntryPropCommon &
      EntryPropDatas &
      EntryPropSegments &
      EntryPropRender)
  | ParallelEntryData
  | ({
      type: "cache";
      /** Cache entries create cache boundaries and render like layouts (with Outlet) */
      handler: ReactNode | Handler<any, any, any>;
    } & EntryPropCommon &
      EntryPropDatas &
      EntryPropSegments &
      EntryPropRender);

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
  /** True when this scope is at root level (no named include boundary above).
   *  Routes at root scope allow dot-local reverse to fall back to bare names. */
  rootScoped?: boolean;
  /** Run helper for cleaner middleware code */
  run?: <T>(fn: () => T | Promise<T>) => T | Promise<T>;
  /** Tracked includes for build-time manifest generation */
  trackedIncludes?: TrackedInclude[];
  /** Cache profiles for DSL-time cache("profileName") resolution */
  cacheProfiles?: Record<
    string,
    import("../cache/profile-registry.js").CacheProfile
  >;
  /** True when resolving handlers inside a cache() DSL boundary.
   *  Read by ctx.get() to guard non-cacheable variable reads. */
  insideCacheScope?: boolean;
  /**
   * Include scope string applied to direct-descendant shortCodes.
   *
   * Each `include(...)` call allocates a sibling-positional token like `I0`,
   * `I1` from its parent's include counter and stores the composed scope
   * (`${parentScope}I${idx}`) in its lazyContext. When the include's handler
   * evaluates lazily, the store's `includeScope` is set from that context so
   * every direct-descendant shortCode is generated as
   * `${parent.shortCode}${includeScope}${prefix}${index}` — preventing
   * collisions with siblings declared outside the include.
   *
   * The scope is NOT propagated through `store.run(...)`, so layouts /
   * parallels / caches inside the include absorb the scope into their own
   * shortCodes and their children start fresh.
   */
  includeScope?: string;
}
// Use a global symbol key so the AsyncLocalStorage instance survives HMR
// module re-evaluation. Without this, Vite's RSC module runner may create
// a new instance when context.ts is re-evaluated, while other modules still
// hold references to the old instance — causing getStore() to return
// undefined even inside a run() callback.
const RSC_CONTEXT_KEY = Symbol.for("rangojs-router:rsc-context");
export const RangoContext: AsyncLocalStorage<HelperContext> = ((
  globalThis as any
)[RSC_CONTEXT_KEY] ??= new AsyncLocalStorage<HelperContext>());

/** shortCode prefix letter per entry type (e.g. "L0", "R2", "M1C0"). */
const SHORT_CODE_PREFIX: Record<
  "layout" | "parallel" | "route" | "loader" | "cache",
  string
> = {
  layout: "L",
  parallel: "P",
  route: "R",
  loader: "D",
  cache: "C",
};

/** Post-increment a named per-store counter, returning the prior value. */
function bumpCounter(store: HelperContext, key: string): number {
  store.counters[key] ??= 0;
  return store.counters[key]++;
}

export const getContext = (): {
  context: AsyncLocalStorage<HelperContext>;
  getStore: () => HelperContext;
  getParent: () => EntryData | null;
  getOrCreateStore: (forRoute?: string) => HelperContext;
  getNextIndex: (
    type: (string & {}) | "layout" | "parallel" | "middleware" | "revalidate",
  ) => string;
  getShortCode: (
    type: "layout" | "parallel" | "route" | "loader" | "cache",
  ) => string;
  run: <T>(
    namespace: string,
    parent: EntryData | null,
    callback: (...args: any[]) => T,
  ) => T;
  runWithStore: <T>(
    store: HelperContext,
    namespace: string,
    parent: EntryData | null,
    callback: (...args: any[]) => T,
  ) => T;
} => {
  const context = RangoContext;

  return {
    context,
    getOrCreateStore: (forRoute?: string): HelperContext => {
      let store = RangoContext.getStore();
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
          "Rango context store is not available. Make sure to run within Rango context.",
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
      type: (string & {}) | "layout" | "parallel" | "middleware" | "revalidate",
    ) => {
      const store = context.getStore();
      invariant(store, "No context RangoContext available");
      return `$${type}.${bumpCounter(store, type)}`;
    },
    getShortCode: (
      type: "layout" | "parallel" | "route" | "loader" | "cache",
    ) => {
      const store = context.getStore();
      invariant(store, "No context RangoContext available");

      const parent = store.parent;
      const prefix = SHORT_CODE_PREFIX[type];
      const mountPrefix =
        store.mountIndex !== undefined ? `M${store.mountIndex}` : "";

      const includeScope = store.includeScope ?? "";

      if (!parent) {
        // Root entry: prefix with mount index and use mount-scoped counter
        const counterKey = mountPrefix
          ? `${mountPrefix}_root_${type}`
          : `root_${type}`;
        return `${mountPrefix}${prefix}${bumpCounter(store, counterKey)}`;
      } else {
        // Child entry: use parent-scoped counter with includeScope appended.
        // When we're evaluating a lazy include's direct children, includeScope
        // is a per-include token like "I0" / "I1I0" that partitions the
        // parent's counter namespace so routes inside one include cannot
        // collide with siblings declared outside it.
        const counterKey = `${parent.shortCode}${includeScope}_${type}`;
        return `${parent.shortCode}${includeScope}${prefix}${bumpCounter(store, counterKey)}`;
      }
    },
    runWithStore: <T>(
      store: HelperContext,
      namespace: string,
      parent: EntryData | null,
      callback: (...args: any[]) => T,
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
          rootScoped: store.rootScoped,
          trackedIncludes: store.trackedIncludes,
          cacheProfiles: store.cacheProfiles,
          includeScope: store.includeScope,
        },
        callback,
      );
    },
    run: <T>(
      namespace: string,
      parent: EntryData | null,
      callback: (...args: any[]) => T,
    ) => {
      const store = context.getStore();
      // Preserve parent counters to ensure globally unique shortCodes
      const counters = store?.counters || {};
      const manifest = store ? store.manifest : new Map<string, EntryData>();
      const patterns = store?.patterns || new Map<string, string>();
      const patternsByPrefix = store?.patternsByPrefix;
      const trailingSlash =
        store?.trailingSlash ||
        new Map<string, "never" | "always" | "ignore">();
      const searchSchemas =
        store?.searchSchemas || new Map<string, Record<string, string>>();
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
          patternsByPrefix,
          trailingSlash,
          searchSchemas,
          urlPrefix: store?.urlPrefix,
          namePrefix: store?.namePrefix,
          rootScoped: store?.rootScoped,
          trackedIncludes: store?.trackedIncludes,
          cacheProfiles: store?.cacheProfiles,
        },
        callback,
      );
    },
  };
};

/**
 * Acquire the active DSL build context, throwing `message` if a helper was
 * called outside a urls()/map() builder. Returns the store API and the live
 * HelperContext so callers avoid a second getContext() lookup.
 */
export function requireDslContext(message: string): {
  store: ReturnType<typeof getContext>;
  ctx: HelperContext;
} {
  const store = getContext();
  const ctx = store.context.getStore();
  if (!ctx) {
    // The only reason the store is absent here is that a route-definition helper
    // ran with no active RangoContext — i.e. outside a urls()/map() builder.
    // Record that as the cause so the throw is self-explanatory, not a bare
    // "must be called inside urls()" with no indication of the mechanism.
    throw new DslContextError(message, {
      cause:
        "RangoContext store is undefined: a route-definition helper was called " +
        "outside an active urls()/map() builder.",
    });
  }
  return { store, ctx };
}

/**
 * Run a callback with specific URL and name prefixes
 * Used by include() to apply prefixes to nested patterns
 */
export function runWithPrefixes<T>(
  urlPrefix: string,
  namePrefix: string | undefined,
  callback: () => T,
): T {
  const store = RangoContext.getStore();
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
  const combinedNamePrefix =
    namePrefix !== undefined
      ? namePrefix === ""
        ? store.namePrefix
        : store.namePrefix
          ? `${store.namePrefix}.${namePrefix}`
          : namePrefix
      : store.namePrefix;

  // Track root scope for dot-local reverse resolution.
  //
  // The flag answers: "can this route reach bare names at root scope?"
  // It propagates through the include chain:
  //
  //   { name: "" }    — transparent: inherit parent, default true
  //   { name: "foo" } — inherit parent if already set, else create boundary (false)
  //   no name          — inherit parent unchanged
  //
  // This means { name: "" } + nested { name: "sub" } keeps rootScoped=true
  // (the outer transparent include establishes root access, and the inner
  // named include inherits it). But a direct { name: "sub" } at root gets
  // rootScoped=false (no prior root-access grant, so it creates a boundary).
  const combinedRootScoped =
    namePrefix === ""
      ? (store.rootScoped ?? true)
      : namePrefix !== undefined
        ? (store.rootScoped ?? false)
        : store.rootScoped;

  return RangoContext.run(
    {
      ...store,
      urlPrefix: combinedUrlPrefix,
      namePrefix: combinedNamePrefix,
      rootScoped: combinedRootScoped,
    },
    callback,
  );
}

/**
 * Get current URL prefix from context
 */
export function getUrlPrefix(): string {
  const store = RangoContext.getStore();
  return store?.urlPrefix || "";
}

/**
 * Get current name prefix from context
 */
export function getNamePrefix(): string | undefined {
  const store = RangoContext.getStore();
  return store?.namePrefix;
}

/**
 * Get whether the current scope is at root level (no named include boundary above).
 * Returns true at root or inside { name: "" } includes, false inside named includes.
 */
export function getRootScoped(): boolean {
  const store = RangoContext.getStore();
  return store?.rootScoped ?? true;
}

// Export HelperContext type for use in other modules
export type { HelperContext };

/**
 * Return an isolated copy of a lazy include's captured parent entry.
 *
 * DSL helpers (loader(), middleware(), etc.) mutate ctx.parent in place.
 * Multiple include() scopes capture the *same* syntheticMapRoot as their
 * parent, so without isolation one include's loaders/middleware leak into
 * every other route that shares that root.
 *
 * The clone is shallow: only the mutable arrays are copied so each
 * include pushes to its own list. The rest of the entry (id, shortCode,
 * parent pointer, handler) stays shared, which is correct and cheap.
 */
export function getIsolatedLazyParent(
  captured: EntryData | null | undefined,
): EntryData | null {
  if (!captured) return null;
  return {
    ...captured,
    loader: [...captured.loader],
    middleware: [...captured.middleware],
    revalidate: [...captured.revalidate],
    errorBoundary: [...captured.errorBoundary],
    notFoundBoundary: [...captured.notFoundBoundary],
    layout: [...captured.layout],
    parallel: { ...captured.parallel },
    intercept: [...captured.intercept],
  };
}

export function getParallelEntries(
  parallels: ParallelEntries | EntryData[] | undefined,
): ParallelEntryData[] {
  if (!parallels) return [];
  if (Array.isArray(parallels)) {
    return parallels.filter(
      (entry): entry is ParallelEntryData => entry.type === "parallel",
    );
  }
  return Object.values(parallels).filter(
    (entry): entry is ParallelEntryData => !!entry,
  );
}

export function getParallelSlotEntries(
  parallels: ParallelEntries | EntryData[] | undefined,
): Array<{ slot: `@${string}`; entry: ParallelEntryData }> {
  if (!parallels) return [];

  if (Array.isArray(parallels)) {
    return getParallelEntries(parallels).flatMap((entry) =>
      (Object.keys(entry.handler) as `@${string}`[]).map((slot) => ({
        slot,
        entry,
      })),
    );
  }

  return Object.entries(parallels)
    .filter(([, entry]) => !!entry)
    .map(([slot, entry]) => ({
      slot: slot as `@${string}`,
      entry: entry!,
    }));
}

export function getParallelSlotCount(
  parallels: ParallelEntries | EntryData[] | undefined,
): number {
  if (!parallels) return 0;
  return Array.isArray(parallels)
    ? parallels.filter((entry) => entry?.type === "parallel").length
    : Object.keys(parallels).length;
}

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
export function track(label: string, depth?: number): () => void {
  const store = RangoContext.getStore();

  // No-op if context unavailable or metrics not enabled
  if (!store?.metrics?.enabled) {
    return () => {};
  }

  const startTime = performance.now() - store.metrics.requestStart;

  return () => {
    const duration =
      performance.now() - store.metrics!.requestStart - startTime;
    store.metrics!.metrics.push({
      label,
      duration,
      startTime,
      ...(depth != null ? { depth } : {}),
    });
  };
}

/**
 * Separate ALS for tracking loader execution scope.
 * Uses a dedicated ALS (not RangoContext) to avoid issues with
 * nested RangoContext.run() calls in Vite's module runner.
 */
const LOADER_SCOPE_KEY = Symbol.for("rangojs-router:loader-scope");
const loaderScopeALS: AsyncLocalStorage<{ active: true }> = ((
  globalThis as any
)[LOADER_SCOPE_KEY] ??= new AsyncLocalStorage<{ active: true }>());

// Purity-only scope: marks that a loader FUNCTION BODY is executing, regardless
// of how the loader was invoked (DSL via runInsideLoaderScope, or handler-
// invoked via ctx.use). Consulted ONLY by isInsideCacheScope() to exempt
// request-scoped reads. It deliberately does NOT affect isInsideLoaderScope(),
// so rendered()/barrier/deadlock gating (which must distinguish DSL from
// handler-invoked loaders) is unchanged.
const LOADER_BODY_SCOPE_KEY = Symbol.for("rangojs-router:loader-body-scope");
const loaderBodyScopeALS: AsyncLocalStorage<{ active: true }> = ((
  globalThis as any
)[LOADER_BODY_SCOPE_KEY] ??= new AsyncLocalStorage<{ active: true }>());

/**
 * Check if the current execution is inside a cache() DSL boundary.
 * Returns false inside loader execution — loaders are always fresh
 * (never cached), so non-cacheable reads are safe.
 */
export function isInsideCacheScope(): boolean {
  if (RangoContext.getStore()?.insideCacheScope !== true) return false;
  // Loaders are always fresh — even inside a cache() boundary, the loader
  // function re-executes on every request. Skip the guard when running
  // inside a loader.
  if (loaderScopeALS.getStore()?.active) return false;
  // Also exempt handler-invoked loaders: their bodies run in a loader-body
  // scope (not the DSL loader scope above), so request-scoped reads inside any
  // loader — however invoked — are safe (loaders always re-run fresh).
  if (loaderBodyScopeALS.getStore()?.active) return false;
  return true;
}

/**
 * Check if the current execution is inside a DSL loader scope
 * (wrapped by runInsideLoaderScope). Used by rendered() barrier
 * to distinguish DSL loaders from handler-invoked loaders.
 */
export function isInsideLoaderScope(): boolean {
  return loaderScopeALS.getStore()?.active === true;
}

/**
 * Run `fn` inside a loader scope. While active, cache-scope guards
 * are bypassed because loaders are always fresh (never cached) and
 * their side effects (setCookie, header, etc.) are safe.
 */
export function runInsideLoaderScope<T>(fn: () => T): T {
  return loaderScopeALS.run({ active: true }, fn);
}

/**
 * Run `fn` inside a loader BODY scope. Marks loader-function execution for the
 * cache-purity guard only (isInsideCacheScope), WITHOUT affecting
 * isInsideLoaderScope()/rendered() gating. Applied to every loader body (DSL
 * and handler-invoked via ctx.use) so request-scoped reads inside a loader
 * never trip the cache-scope guards — loaders always run fresh.
 */
export function runInsideLoaderBodyScope<T>(fn: () => T): T {
  return loaderBodyScopeALS.run({ active: true }, fn);
}

// Scope for handle PUSH CALLBACKS (push(() => ...), including async ones).
// A push callback's value is stored as-is; if it is a promise it is NOT tracked
// by handleStore.settled and does not block segment resolution, so a
// ctx.use(loader) made from inside such a callback can never form a rendered()
// deadlock. This is an ALS (not a plain boolean) so the exemption survives the
// callback's own awaits — an async push callback that resumes after `await`
// still reads as "inside a push callback" and stays out of the deadlock guard.
const PUSH_CALLBACK_SCOPE_KEY = Symbol.for(
  "rangojs-router:push-callback-scope",
);
const pushCallbackScopeALS: AsyncLocalStorage<{ active: true }> = ((
  globalThis as any
)[PUSH_CALLBACK_SCOPE_KEY] ??= new AsyncLocalStorage<{ active: true }>());

/**
 * Check if the current execution is inside a handle push callback (sync or an
 * async callback's continuation). Used by the handler-to-loader deadlock guard
 * to exempt push-callback continuations.
 */
export function isInsidePushCallbackScope(): boolean {
  return pushCallbackScopeALS.getStore()?.active === true;
}

/**
 * Run `fn` inside a push-callback scope. Wraps the invocation of a handle push
 * callback so that any ctx.use(loader) it makes — including after one of its own
 * awaits — is exempt from the deadlock guard.
 */
export function runInsidePushCallbackScope<T>(fn: () => T): T {
  return pushCallbackScopeALS.run({ active: true }, fn);
}
