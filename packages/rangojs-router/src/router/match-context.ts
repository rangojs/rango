/**
 * Match Context for Router Pipeline
 *
 * Encapsulates all state needed by the match pipeline middleware.
 * Created once at the start of match()/matchPartial() and passed through the pipeline.
 *
 * DATA FLOW ARCHITECTURE
 * ======================
 *
 * The router uses two complementary data structures:
 *
 *   MatchContext (ctx)        - Immutable request state
 *   MatchPipelineState (state) - Mutable pipeline state
 *
 *
 *   Request
 *      |
 *      v
 *   +-------------------+
 *   | Create Context    |  ctx = immutable snapshot of request
 *   +-------------------+
 *      |
 *      v
 *   +-------------------+
 *   | Create State      |  state = mutable accumulator
 *   +-------------------+
 *      |
 *      +---> [Pipeline Middleware]
 *      |           |
 *      |     ctx: read-only
 *      |     state: read/write
 *      |           |
 *      +<----------+
 *      |
 *      v
 *   +-------------------+
 *   | Build Result      |  Merge ctx + state into MatchResult
 *   +-------------------+
 *
 *
 * MATCHCONTEXT FIELDS
 * ===================
 *
 * Request Info:
 *   - request, url, pathname: The incoming HTTP request
 *
 * Environment:
 *   - env: Server environment bindings (Cloudflare bindings, etc.)
 *
 * Client State (from RSC request headers):
 *   - clientSegmentIds: Segments the client currently has
 *   - clientSegmentSet: Set version for O(1) lookup
 *   - stale: Whether client considers its cache stale
 *
 * Navigation State:
 *   - prevUrl, prevParams, prevMatch: Previous navigation for comparison
 *
 * Current Match:
 *   - matched: Route match result (params, route key)
 *   - manifestEntry: Resolved manifest data
 *   - entries: All route entries (layouts, loaders, etc.)
 *   - routeKey, localRouteName: Route identifiers
 *
 * Handler Context:
 *   - handlerContext: Context passed to loaders
 *   - loaderPromises: Memoized loader promises
 *
 * Intercepts:
 *   - interceptResult: Detected intercept (if soft navigation)
 *   - interceptSelectorContext: Context for intercept matching
 *
 * Cache:
 *   - cacheScope: Cache configuration and methods
 *   - isIntercept: Whether this is an intercept request
 *
 * Flags:
 *   - isAction: POST/mutation request
 *   - isFullMatch: Document request vs navigation
 *
 *
 * MATCHPIPELINESTATE FIELDS
 * =========================
 *
 * State flags (set by middleware, read by others):
 *   - cacheHit: Cache lookup succeeded
 *   - shouldRevalidate: SWR revalidation needed
 *
 * Segment accumulation:
 *   - segments: Resolved segments from pipeline
 *   - matchedIds: All segment IDs in match order
 *   - cachedSegments: Segments from cache (if hit)
 *
 * Intercept data:
 *   - interceptSegments: Segments for modal slots
 *   - slots: Named slot data for client
 *
 *
 * IMMUTABILITY CONTRACT
 * =====================
 *
 * MatchContext is treated as immutable after creation.
 * Middleware should NEVER modify ctx properties.
 *
 * MatchPipelineState is explicitly mutable.
 * Middleware communicate by setting state flags.
 *
 * This separation ensures:
 *   - Request data is consistent across all middleware
 *   - Pipeline state changes are explicit and trackable
 *   - No hidden side effects in request handling
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

  // Route map for server-side ctx.reverse() resolution
  routeMap: Record<string, string>;

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
// functions from createRouter(). The implementation will live in router.ts initially
// and call getRouterContext() to access these dependencies.
