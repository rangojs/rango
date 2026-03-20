import type { ReactNode } from "react";
import type { ErrorInfo, NotFoundInfo } from "./boundaries.js";

/**
 * CSS class(es) for a ViewTransition phase.
 * Can be a simple string or an object mapping transition types to class names
 * for direction-aware transitions (e.g., { "navigation": "slide-right", "navigation-back": "slide-left" }).
 */
export type ViewTransitionClass = Record<string, string> | string;

/**
 * Configuration for React's <ViewTransition> component.
 * Maps directly to ViewTransitionProps (minus children/ref/callbacks).
 */
export interface TransitionConfig {
  enter?: ViewTransitionClass;
  exit?: ViewTransitionClass;
  update?: ViewTransitionClass;
  share?: ViewTransitionClass;
  default?: ViewTransitionClass;
  name?: string;
}

/**
 * Resolved segment with component
 *
 * Segment types:
 * - layout: Wraps child content via <Outlet />
 * - route: The leaf content for a URL
 * - parallel: Named slots rendered via <ParallelOutlet name="@slot" />
 * - loader: Data segment (no visual rendering, carries loaderData)
 * - error: Error fallback segment (replaces failed segment with error UI)
 * - notFound: Not found fallback segment (replaces segment when data not found)
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export interface ResolvedSegment {
  id: string;
  namespace: string; // Optional namespace for segment (used for parallel groups)
  type: "layout" | "route" | "parallel" | "loader" | "error" | "notFound";
  index: number;
  component: ReactNode; // Component, handler promise, or resolved element
  loading?: ReactNode; // Loading component for this segment (shown during navigation)
  transition?: TransitionConfig; // ViewTransition config for this segment
  layout?: ReactNode; // Layout element to wrap content (used by intercept segments)
  params?: Record<string, string>;
  slot?: string; // For parallel segments: '@sidebar', '@modal', etc.
  belongsToRoute?: boolean; // True if segment belongs to the matched route (route itself + its children)
  layoutName?: string; // For layouts: the layout name identifier
  parallelName?: string; // For parallels: the parallel group name (used to match with revalidations)
  // Loader-specific fields
  loaderId?: string; // For loaders: the loader $$id identifier
  loaderData?: any; // For loaders: the resolved data from loader execution
  parallelLoading?: ReactNode; // For parallel-owned loaders: the parallel's loading fallback
  // Intercept loader fields (for streaming loader data in parallel segments)
  loaderDataPromise?: Promise<any[]> | any[]; // Loader data promise or resolved array
  loaderIds?: string[]; // IDs ($$id) of loaders for this segment
  parallelLoaderSources?: any[]; // Internal: preserves stable aggregate promise across renders
  // Error-specific fields
  error?: ErrorInfo; // For error segments: the error information
  // NotFound-specific fields
  notFoundInfo?: NotFoundInfo; // For notFound segments: the not found information
  // Mount path from include() scope, used for MountContext.Provider wrapping
  mountPath?: string;
}

/**
 * Segment metadata (without component)
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export interface SegmentMetadata {
  id: string;
  type: "layout" | "route" | "parallel" | "loader" | "error" | "notFound";
  index: number;
  params?: Record<string, string>;
  slot?: string;
  loaderId?: string;
  error?: ErrorInfo;
  notFoundInfo?: NotFoundInfo;
}

// Note: route symbols are now defined in route-definition.ts
// as properties on the route() function

/**
 * State of a named slot (e.g., @modal, @sidebar)
 * Used for intercepting routes where slots render alternative content
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export interface SlotState {
  /**
   * Whether the slot is currently active (has content to render)
   */
  active: boolean;
  /**
   * Segments for this slot when active
   */
  segments?: ResolvedSegment[];
}

/**
 * Props passed to the root layout component
 */
export interface RootLayoutProps {
  children: ReactNode;
}

/**
 * Router match result
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export interface MatchResult {
  segments: ResolvedSegment[];
  matched: string[];
  diff: string[];
  /**
   * Merged route params from all matched segments
   * Available for use by the handler after route matching
   */
  params: Record<string, string>;
  /**
   * The matched route name (includes name prefix from include()).
   * Used by ctx.reverse() for local name resolution.
   */
  routeName?: string;
  /**
   * State of named slots for this route match
   * Key is slot name (e.g., "@modal"), value is slot state
   * Slots are used for intercepting routes during soft navigation
   */
  slots?: Record<string, SlotState>;
  /**
   * Redirect URL for trailing slash normalization.
   * When set, the RSC handler should return a 308 redirect to this URL
   * instead of rendering the page.
   */
  redirect?: string;
  /**
   * Route-level middleware collected from the matched entry tree.
   * These run with the same onion-style execution as app-level middleware,
   * wrapping the entire RSC response creation.
   */
  routeMiddleware?: Array<{
    handler: import("../router/middleware.js").MiddlewareFn;
    params: Record<string, string>;
  }>;
}
