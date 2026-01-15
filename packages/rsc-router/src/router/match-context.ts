/**
 * Match Context for Router Pipeline
 *
 * Encapsulates all state needed by the match pipeline middleware.
 * Created once at the start of matchPartial() and passed through the pipeline.
 */
import type { CacheScope } from "../cache/cache-scope.js";
import type {
  EntryData,
  InterceptSelectorContext,
  MetricsStore,
} from "../server/context.js";
import type { HandlerContext, ResolvedSegment } from "../types.js";
import type { RouteMatchResult } from "./pattern-matching.js";
import type { InterceptResult } from "./router-context.js";

/**
 * Action context passed to matchPartial
 */
export interface ActionContext {
  actionId?: string;
  actionUrl?: URL;
  actionResult?: any;
  formData?: FormData;
}

/**
 * Match context containing all state for the match pipeline
 */
export interface MatchContext<TEnv = any> {
  // Request info
  request: Request;
  url: URL;
  pathname: string;

  // Environment
  env: TEnv;
  bindings: TEnv;

  // Client state
  clientSegmentIds: string[];
  clientSegmentSet: Set<string>;
  stale: boolean;

  // Previous navigation state
  prevUrl: URL;
  prevParams: Record<string, string>;
  prevMatch: RouteMatchResult | null;

  // Current route match
  matched: RouteMatchResult;
  manifestEntry: EntryData;
  entries: EntryData[];
  routeKey: string;
  localRouteName: string;

  // Handler context (for loaders)
  handlerContext: HandlerContext<any, TEnv>;
  loaderPromises: Map<string, Promise<any>>;

  // Metrics
  metricsStore: MetricsStore | undefined;

  // Store for running within context
  Store: any;

  // Intercept detection
  interceptContextMatch: RouteMatchResult | null;
  interceptSelectorContext: InterceptSelectorContext;
  isSameRouteNavigation: boolean;
  interceptResult: InterceptResult | null;

  // Cache
  cacheScope: CacheScope | null;
  isIntercept: boolean;

  // Action context (if this is an action)
  actionContext?: ActionContext;
  isAction: boolean;

  // Route middleware
  routeMiddleware: Array<{
    handler: any;
    params: Record<string, string>;
  }>;

  // Full match flag (document requests vs partial/navigation requests)
  // When true, uses simpler resolution without revalidation logic
  isFullMatch: boolean;
}

/**
 * Mutable state that flows through the pipeline
 */
export interface MatchPipelineState {
  // Whether cache was hit
  cacheHit: boolean;

  // Cached segments (if cache hit)
  cachedSegments?: ResolvedSegment[];
  cachedMatchedIds?: string[];

  // Whether cache should be revalidated (SWR)
  shouldRevalidate?: boolean;

  // Resolved segments from pipeline
  segments: ResolvedSegment[];
  matchedIds: string[];

  // Intercept segments
  interceptSegments: ResolvedSegment[];

  // Slots state
  slots: Record<
    string,
    {
      active: boolean;
      segments: ResolvedSegment[];
    }
  >;
}

/**
 * Create initial pipeline state
 */
export function createPipelineState(): MatchPipelineState {
  return {
    cacheHit: false,
    segments: [],
    matchedIds: [],
    interceptSegments: [],
    slots: {},
  };
}

/**
 * Input parameters for createMatchContext
 */
export interface CreateMatchContextInput<TEnv = any> {
  request: Request;
  env: TEnv;
  actionContext?: ActionContext;
}

/**
 * Result from createMatchContext - either a context or null (fall back to full match)
 */
export type CreateMatchContextResult<TEnv = any> =
  | { type: "context"; ctx: MatchContext<TEnv> }
  | { type: "fallback"; reason: string }
  | { type: "error"; error: Error };

// Note: createMatchContext() will be implemented in Step J10 when we wire everything together.
// It requires access to RouterContext (findMatch, loadManifest, etc.) which are closure
// functions from createRSCRouter(). The implementation will live in router.ts initially
// and call getRouterContext() to access these dependencies.
