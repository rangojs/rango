import { AsyncLocalStorage } from "node:async_hooks";
import type { ReactNode } from "react";
import type { ErrorBoundaryHandler, Handler, LoaderDefinition, MiddlewareFn, NotFoundBoundaryHandler, ShouldRevalidateFn } from "../types";
import { invariant } from "../errors";

// ============================================================================
//  Performance Metrics Types
// ============================================================================

/**
 * Performance metric entry for a single measured operation
 */
export interface PerformanceMetric {
  label: string;      // e.g., "route-matching", "loader:UserLoader"
  duration: number;   // milliseconds
  startTime: number;  // relative to request start
}

/**
 * Request-scoped metrics store
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
 * Entry data structure for manifest
 */
export type EntryPropCommon = {
  id: string;
  shortCode: string; // Short identifier for network efficiency (e.g., "L0", "P1", "R2")
  parent: EntryData | null;
};
export type EntryPropDatas = {
  middleware: MiddlewareFn<any, any>[];
  revalidate: ShouldRevalidateFn<any, any>[];
  errorBoundary: (ReactNode | ErrorBoundaryHandler)[];
  notFoundBoundary: (ReactNode | NotFoundBoundaryHandler)[];
};
/**
 * Loader entry stored in EntryData
 * Contains the loader definition and its revalidation rules
 */
export type LoaderEntry = {
  loader: LoaderDefinition<any>;
  revalidate: ShouldRevalidateFn<any, any>[];
};

/**
 * Segments state for intercept context
 * Matches the structure from useSegments() for consistency
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
 */
export type InterceptWhenFn<TEnv = any> = (ctx: InterceptSelectorContext<TEnv>) => boolean;

/**
 * Intercept entry stored in EntryData
 * Contains the slot name, route to intercept, and handler
 */
export type InterceptEntry = {
  slotName: `@${string}`;  // e.g., "@modal"
  routeName: string;        // e.g., "card"
  handler: ReactNode | Handler<any, any>;
  middleware: MiddlewareFn<any, any>[];
  revalidate: ShouldRevalidateFn<any, any>[];
  errorBoundary: (ReactNode | ErrorBoundaryHandler)[];
  notFoundBoundary: (ReactNode | NotFoundBoundaryHandler)[];
  loader: LoaderEntry[];
  loading?: ReactNode | false;
  layout?: ReactNode | Handler<any, any>;  // Wrapper layout with <Outlet /> for content
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
      handler: Handler<any, any>;
      loading?: ReactNode | false;
    } & EntryPropCommon &
      EntryPropDatas &
      EntryPropSegments)
  | ({
      type: "layout";
      handler: ReactNode | Handler<any, any>;
      loading?: ReactNode | false;
    } & EntryPropCommon &
      EntryPropDatas &
      EntryPropSegments)
  | ({
      type: "parallel";
      handler: Record<`@${string}`, Handler<any, any> | ReactNode>;
      loading?: ReactNode | false;
    } & EntryPropCommon &
      EntryPropDatas &
      EntryPropSegments);

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
    type: "layout" | "parallel" | "route" | "loader"
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
    getShortCode: (type: "layout" | "parallel" | "route" | "loader") => {
      const store = context.getStore();
      invariant(store, "No context RSCRouterContext available");

      const parent = store.parent;
      const prefix = type === "layout" ? "L" : type === "parallel" ? "P" : type === "loader" ? "D" : "R";
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
        },
        callback
      );
    },
  };
};

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
