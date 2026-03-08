/**
 * Phase where the error occurred during request handling.
 *
 * Coverage notes:
 * - "routing": Invoked when route matching fails (router.ts, rsc/handler.ts)
 * - "manifest": Reserved for manifest loading errors (not currently invoked)
 * - "middleware": Reserved for middleware execution errors (errors propagate to handler phase)
 * - "loader": Invoked when loader execution fails (router.ts via wrapLoaderWithErrorHandling, rsc/handler.ts)
 * - "handler": Invoked when route/layout handler execution fails (router.ts)
 * - "rendering": Invoked during SSR rendering errors (ssr/index.tsx, separate callback)
 * - "action": Invoked when server action execution fails (rsc/handler.ts, router.ts)
 * - "revalidation": Invoked when revalidation fails (router.ts, conditional with action)
 * - "unknown": Fallback for unclassified errors (not currently invoked)
 */
export type ErrorPhase =
  | "routing" // During route matching
  | "manifest" // During manifest loading (reserved, not currently invoked)
  | "middleware" // During middleware execution (errors propagate to handler phase)
  | "loader" // During loader execution
  | "handler" // During route/layout handler execution
  | "rendering" // During RSC/SSR rendering (SSR handler uses separate callback)
  | "action" // During server action execution
  | "revalidation" // During revalidation evaluation
  | "cache" // During "use cache" background operations (stale revalidation, async cache writes)
  | "prerender" // During build-time pre-rendering (Vite closeBundle)
  | "static" // During build-time static handler rendering (Vite closeBundle)
  | "unknown"; // Fallback for unclassified errors

/**
 * Comprehensive context passed to onError callback
 *
 * Provides all available information about where and when an error occurred
 * during request handling. The callback can use this for logging, monitoring,
 * error tracking services, or custom error responses.
 *
 * @example
 * ```typescript
 * const router = createRouter<AppEnv>({
 *   onError: (context) => {
 *     // Log to error tracking service
 *     errorTracker.capture({
 *       error: context.error,
 *       phase: context.phase,
 *       url: context.request.url,
 *       route: context.routeKey,
 *       userId: context.env?.user?.id,
 *     });
 *
 *     // Log to console with context
 *     console.error(`[${context.phase}] Error in ${context.routeKey}:`, {
 *       message: context.error.message,
 *       segment: context.segmentId,
 *       duration: context.duration,
 *     });
 *   },
 * });
 * ```
 */
export interface OnErrorContext<TEnv = any> {
  /**
   * The error that occurred
   */
  error: Error;

  /**
   * Phase where the error occurred
   */
  phase: ErrorPhase;

  /**
   * The original request
   */
  request: Request;

  /**
   * Parsed URL from the request
   */
  url: URL;

  /**
   * Request pathname
   */
  pathname: string;

  /**
   * HTTP method
   */
  method: string;

  /**
   * Matched route key (if available)
   * e.g., "shop.products.detail"
   */
  routeKey?: string;

  /**
   * Route params (if available)
   * e.g., { slug: "headphones" }
   */
  params?: Record<string, string>;

  /**
   * Segment ID where error occurred (if available)
   * e.g., "M1L0" for a layout, "M1R0" for a route
   */
  segmentId?: string;

  /**
   * Segment type where error occurred (if available)
   */
  segmentType?: "layout" | "route" | "parallel" | "loader" | "middleware";

  /**
   * Loader name (if error occurred in a loader)
   */
  loaderName?: string;

  /**
   * Middleware name/id (if error occurred in middleware)
   */
  middlewareId?: string;

  /**
   * Action ID (if error occurred during server action)
   * e.g., "src/actions.ts#addToCart"
   */
  actionId?: string;

  /**
   * Environment/bindings (platform context)
   */
  env?: TEnv;

  /**
   * Duration from request start to error (milliseconds)
   */
  duration?: number;

  /**
   * Whether this is a partial/navigation request
   */
  isPartial?: boolean;

  /**
   * Whether an error boundary caught the error
   * If true, the error was handled and a fallback UI was rendered
   */
  handledByBoundary?: boolean;

  /**
   * Stack trace (if available)
   */
  stack?: string;

  /**
   * Additional metadata specific to the error phase
   */
  metadata?: Record<string, unknown>;
}

/**
 * Callback function for error handling
 *
 * Called whenever an error occurs during request handling.
 * The callback is for notification/logging purposes - it cannot
 * modify the error handling flow (use errorBoundary for that).
 *
 * @param context - Comprehensive error context
 *
 * @example
 * ```typescript
 * const onError: OnErrorCallback = (context) => {
 *   // Send to error tracking service
 *   Sentry.captureException(context.error, {
 *     tags: {
 *       phase: context.phase,
 *       route: context.routeKey,
 *     },
 *     extra: {
 *       url: context.url.toString(),
 *       params: context.params,
 *       duration: context.duration,
 *     },
 *   });
 * };
 * ```
 */
export type OnErrorCallback<TEnv = any> = (
  context: OnErrorContext<TEnv>,
) => void | Promise<void>;
