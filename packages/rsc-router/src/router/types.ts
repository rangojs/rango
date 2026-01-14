/**
 * Router Internal Types
 *
 * Shared types for router module utilities.
 */

import type { ReactNode } from "react";
import type { EntryData, InterceptEntry, MetricsStore } from "../server/context";
import type {
  ResolvedSegment,
  HandlerContext,
  ErrorBoundaryHandler,
  NotFoundBoundaryHandler,
} from "../types";

/**
 * Result of resolving loaders with revalidation
 * Contains both segments to render and all matched segment IDs
 */
export interface LoaderRevalidationResult {
  segments: ResolvedSegment[];
  matchedIds: string[];
}

/**
 * Result of resolving segments with revalidation
 * Contains both segments to render and all matched segment IDs
 */
export interface SegmentRevalidationResult {
  segments: ResolvedSegment[];
  matchedIds: string[];
}

/**
 * Action context type for revalidation
 */
export type ActionContext = {
  actionId?: string;
  actionUrl?: URL;
  actionResult?: any;
  formData?: FormData;
};

/**
 * Dependencies passed to segment resolution functions
 * These are created within createRSCRouter and passed to extracted utilities
 */
export interface RouterDependencies<TEnv> {
  findNearestErrorBoundary: (
    entry: EntryData | null
  ) => ReactNode | ErrorBoundaryHandler | null;
  findNearestNotFoundBoundary: (
    entry: EntryData | null
  ) => ReactNode | NotFoundBoundaryHandler | null;
}

/**
 * Title descriptor types for template support
 */
export type TitleDescriptor =
  | string
  | { template: string; default: string } // For layouts - template applied to child titles
  | { absolute: string }; // Bypass parent template

/**
 * Unset descriptor to remove inherited meta
 * Key format matches getMetaKey output: "title", "name:description", "property:og:image"
 */
export type UnsetDescriptor = { unset: string };

/**
 * Base meta descriptor types (sync values)
 */
export type MetaDescriptorBase =
  | { charSet: "utf-8" }
  | { title: TitleDescriptor }
  | { name: string; content: string }
  | { property: string; content: string }
  | { httpEquiv: string; content: string }
  | { "script:ld+json": LdJsonObject }
  | { tagName: "meta" | "link"; [name: string]: string }
  | UnsetDescriptor
  | { [name: string]: unknown };

/**
 * Meta descriptor that can be sync or async.
 * Use Promise<MetaDescriptorBase> for streaming meta that resolves after initial render.
 */
export type MetaDescriptor = MetaDescriptorBase | Promise<MetaDescriptorBase>;

type LdJsonObject = { [Key in string]: LdJsonValue } & {
  [Key in string]?: LdJsonValue | undefined;
};
type LdJsonArray = LdJsonValue[] | readonly LdJsonValue[];
type LdJsonPrimitive = string | number | boolean | null;
type LdJsonValue = LdJsonPrimitive | LdJsonObject | LdJsonArray;

/**
 * Route match result from findMatch()
 */
export interface RouteMatch {
  entry: any; // RouteEntry from pattern-matching
  routeKey: string;
  params: Record<string, string>;
  redirectTo?: string;
}

/**
 * Intercept match result from findInterceptForRoute()
 */
export interface InterceptResult {
  intercept: InterceptEntry;
  entry: EntryData;
}

/**
 * Resolution context for partial matching
 *
 * Bundles all parameters needed during segment resolution to reduce
 * parameter passing between functions. This is the shared state that
 * flows through matchPartial and its helpers.
 */
export interface ResolutionContext<TEnv = any> {
  // Request information
  /** The original request */
  request: Request;
  /** Parsed URL from request */
  url: URL;
  /** URL pathname */
  pathname: string;
  /** Previous URL (from header or referer) */
  prevUrl: URL;
  /** Raw previous URL string from header */
  previousUrlRaw: string;
  /** Intercept source URL for maintaining intercept context during actions */
  interceptSourceUrl: string | null;
  /** Whether this is a stale cache revalidation request */
  stale: boolean;

  // Route matching results
  /** Current route match result */
  matched: RouteMatch;
  /** Previous route match result (may be null) */
  prevMatch: RouteMatch | null;
  /** Match for intercept context (differs from prevMatch during action from intercepted modal) */
  interceptContextMatch: RouteMatch | null;
  /** Loaded manifest entry for the matched route */
  manifestEntry: EntryData;
  /** Entries from root to matched route (from traverseBack) */
  entries: EntryData[];

  // Client state
  /** Segment IDs the client currently has */
  clientSegmentIds: string[];
  /** Set version for O(1) lookup */
  clientSegmentSet: Set<string>;
  /** Previous route params for revalidation comparison */
  prevParams: Record<string, string>;

  // Platform context
  /** Platform bindings (Cloudflare env, etc.) */
  bindings: TEnv;
  /** Handler context with request utilities */
  handlerContext: HandlerContext<any, TEnv>;
  /** Action context if this is an action request */
  actionContext?: ActionContext;

  // Shared mutable state
  /** Loader promises for parallel execution and ctx.use() */
  loaderPromises: Map<string, Promise<any>>;
  /** Metrics store for performance tracking */
  metricsStore: MetricsStore | null;

  // Computed values
  /** Whether this is an action request */
  isAction: boolean;
  /** Local route name (last segment of routeKey) */
  localRouteName: string;
  /** Whether navigating within the same route (e.g., product/a -> product/b) */
  isSameRouteNavigation: boolean;
}

/**
 * Options for building a ResolutionContext
 * These are the raw inputs before processing
 */
export interface BuildResolutionContextOptions<TEnv = any> {
  request: Request;
  context: TEnv;
  actionContext?: ActionContext;
  findMatch: (pathname: string) => RouteMatch | null;
  loadManifest: (
    entry: any,
    routeKey: string,
    pathname: string,
    metricsStore: MetricsStore | null,
    isSSR: boolean
  ) => Promise<EntryData>;
  traverseBack: (entry: EntryData) => Iterable<EntryData>;
  createHandlerContext: (
    params: Record<string, string>,
    request: Request,
    searchParams: URLSearchParams,
    pathname: string,
    url: URL,
    bindings: TEnv
  ) => HandlerContext<any, TEnv>;
  getMetricsStore: () => MetricsStore | null;
}

/**
 * Result from segment resolution (cache hit or miss paths)
 */
export interface SegmentResolutionResult {
  segments: ResolvedSegment[];
  matchedIds: string[];
}

/**
 * Slot state for intercept rendering
 */
export interface SlotState {
  active: boolean;
  segments: ResolvedSegment[];
}

/**
 * Combined result before finalization
 * Used to pass data between cache hit/miss handlers and finalization
 */
export interface PartialMatchIntermediateResult {
  /** Resolved segments (from cache or fresh resolution) */
  result: SegmentResolutionResult;
  /** Intercept segments if intercept is active */
  interceptSegments: ResolvedSegment[];
  /** Slot states for active intercepts */
  slots: Record<string, SlotState>;
  /** Whether this was a cache hit */
  cacheHit: boolean;
}
