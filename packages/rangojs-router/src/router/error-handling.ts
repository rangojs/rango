/**
 * Router Error Handling Utilities
 *
 * Error boundary and not-found boundary handling for Rango.
 * Also includes the shared invokeOnError utility for error callback invocation.
 */

import { createElement, type ReactNode } from "react";
import type { EntryData } from "../server/context";
import type {
  ResolvedSegment,
  ErrorInfo,
  ErrorBoundaryHandler,
  ErrorBoundaryFallbackProps,
  NotFoundInfo,
  NotFoundBoundaryHandler,
  NotFoundBoundaryFallbackProps,
  ErrorPhase,
  OnErrorCallback,
  OnErrorContext,
} from "../types";

/**
 * Context required to invoke the onError callback.
 * This is a subset of OnErrorContext that callers must provide.
 */
export interface InvokeOnErrorContext<TEnv = any> {
  request: Request;
  url: URL;
  routeKey?: string;
  params?: Record<string, string>;
  segmentId?: string;
  segmentType?: "layout" | "route" | "parallel" | "loader" | "middleware";
  loaderName?: string;
  middlewareId?: string;
  actionId?: string;
  env?: TEnv;
  isPartial?: boolean;
  handledByBoundary?: boolean;
  metadata?: Record<string, unknown>;
  /** Request start time from performance.now() for duration calculation */
  requestStartTime?: number;
}

/**
 * Invoke the onError callback with comprehensive context.
 * Catches any errors in the callback itself to prevent masking the original error.
 *
 * This is a shared utility used by both the router and RSC handler to ensure
 * consistent error callback behavior across the codebase.
 *
 * @param onError - The onError callback to invoke (may be undefined)
 * @param error - The error that occurred
 * @param phase - The phase where the error occurred
 * @param context - Additional context about the error
 * @param logPrefix - Prefix for console.error messages (e.g., "Router" or "RSC")
 */
export function invokeOnError<TEnv = any>(
  onError: OnErrorCallback<TEnv> | undefined,
  error: unknown,
  phase: ErrorPhase,
  context: InvokeOnErrorContext<TEnv>,
  logPrefix: string = "Router",
): void {
  if (!onError) return;

  const errorObj = error instanceof Error ? error : new Error(String(error));
  const duration = context.requestStartTime
    ? performance.now() - context.requestStartTime
    : undefined;

  const errorContext: OnErrorContext<TEnv> = {
    error: errorObj,
    phase,
    request: context.request,
    url: context.url,
    pathname: context.url?.pathname,
    method: context.request?.method,
    routeKey: context.routeKey,
    params: context.params,
    segmentId: context.segmentId,
    segmentType: context.segmentType,
    loaderName: context.loaderName,
    middlewareId: context.middlewareId,
    actionId: context.actionId,
    env: context.env,
    duration,
    isPartial: context.isPartial,
    handledByBoundary: context.handledByBoundary,
    stack: errorObj.stack,
    metadata: context.metadata,
  };

  try {
    const result = onError(errorContext);
    // If onError returns a promise, catch any rejections
    if (result instanceof Promise) {
      result.catch((callbackError) => {
        console.error(`[${logPrefix}.onError] Callback error:`, callbackError);
      });
    }
  } catch (callbackError) {
    // Log but don't throw - we don't want callback errors to mask the original error
    console.error(`[${logPrefix}.onError] Callback error:`, callbackError);
  }
}

/**
 * Find the nearest error boundary by walking up the entry chain
 * Also checks sibling layouts (orphan layouts) for error boundaries
 * Returns the first fallback found, or the default error boundary if configured
 */
export function findNearestErrorBoundary(
  entry: EntryData | null,
  defaultErrorBoundary?: ReactNode | ErrorBoundaryHandler,
): ReactNode | ErrorBoundaryHandler | null {
  let current: EntryData | null = entry;

  while (current) {
    if (current.errorBoundary && current.errorBoundary.length > 0) {
      return current.errorBoundary[current.errorBoundary.length - 1];
    }

    if (current.layout && current.layout.length > 0) {
      for (const orphan of current.layout) {
        if (orphan.errorBoundary && orphan.errorBoundary.length > 0) {
          return orphan.errorBoundary[orphan.errorBoundary.length - 1];
        }
      }
    }

    current = current.parent;
  }

  // Return default error boundary if configured
  return defaultErrorBoundary || null;
}

/**
 * Find the nearest notFound boundary by walking up the entry chain
 * Returns the first fallback found, or the default notFound boundary if configured
 */
export function findNearestNotFoundBoundary(
  entry: EntryData | null,
  defaultNotFoundBoundary?: ReactNode | NotFoundBoundaryHandler,
): ReactNode | NotFoundBoundaryHandler | null {
  let current: EntryData | null = entry;

  while (current) {
    if (current.notFoundBoundary && current.notFoundBoundary.length > 0) {
      return current.notFoundBoundary[current.notFoundBoundary.length - 1];
    }

    // Check orphan layouts mirroring findNearestErrorBoundary: notFoundBoundary
    // attaches identically (onto parent.notFoundBoundary), and an orphan layout
    // (parent=null) is reachable only via this scan. First sibling is "outer".
    if (current.layout && current.layout.length > 0) {
      for (const orphan of current.layout) {
        if (orphan.notFoundBoundary && orphan.notFoundBoundary.length > 0) {
          return orphan.notFoundBoundary[orphan.notFoundBoundary.length - 1];
        }
      }
    }

    current = current.parent;
  }

  // Return default notFound boundary if configured
  return defaultNotFoundBoundary || null;
}

/**
 * Normalize an error's cause into a Flight-serializable shape.
 * ErrorInfo.cause crosses the RSC serialization boundary (via
 * LoaderDataResult.error + error-segment fallback props); a non-serializable
 * cause (function, class instance, circular object) would make Flight
 * serialization throw and mask the original loader error.
 */
function normalizeCause(cause: unknown): unknown {
  if (cause == null) return undefined;
  const t = typeof cause;
  if (t === "string" || t === "number" || t === "boolean") return cause;
  // The whole body is guarded: even `instanceof`/clone can run user code (a
  // Proxy trap, a throwing getter), and this helper must never throw —
  // throwing here would mask the original loader error it exists to protect.
  try {
    if (cause instanceof Error) {
      return { name: cause.name, message: cause.message, stack: cause.stack };
    }
    // Prefer preserving a serializable object/array intact (Flight uses
    // structured-clone-like semantics); fall back to a string when the value
    // is circular, host-bound, or otherwise non-serializable.
    return structuredClone(cause);
  } catch {
    try {
      return String(cause);
    } catch {
      return "[unstringifiable cause]";
    }
  }
}

/**
 * Create ErrorInfo from an error object
 * Sanitizes error details in production
 */
export function createErrorInfo(
  error: unknown,
  segmentId: string,
  segmentType: ErrorInfo["segmentType"],
): ErrorInfo {
  const isDev = process.env.NODE_ENV !== "production";

  if (error instanceof Error) {
    return {
      message: isDev ? error.message : "An error occurred",
      name: error.name,
      code: (error as any).code,
      stack: isDev ? error.stack : undefined,
      cause: isDev ? normalizeCause(error.cause) : undefined,
      segmentId,
      segmentType,
    };
  }

  // Non-Error thrown
  return {
    message: isDev ? String(error) : "An error occurred",
    name: "Error",
    segmentId,
    segmentType,
  };
}

/**
 * Create an error segment with the fallback component
 * Renders the fallback with error info and reset function
 */
export function createErrorSegment(
  errorInfo: ErrorInfo,
  fallback: ReactNode | ErrorBoundaryHandler,
  entry: EntryData,
  params: Record<string, string>,
): ResolvedSegment {
  let component: ReactNode;

  if (typeof fallback === "function") {
    const props: ErrorBoundaryFallbackProps = {
      error: errorInfo,
    };
    component = fallback(props);
  } else {
    component = fallback;
  }

  return {
    id: entry.shortCode,
    namespace: entry.id,
    type: "error",
    index: 0,
    component,
    params,
    error: errorInfo,
  };
}

/**
 * Create NotFoundInfo from a DataNotFoundError
 */
export function createNotFoundInfo(
  error: { message: string },
  segmentId: string,
  segmentType: NotFoundInfo["segmentType"],
  pathname?: string,
): NotFoundInfo {
  return {
    message: error.message,
    segmentId,
    segmentType,
    pathname,
  };
}

/** Router-level `createRouter({ notFound })` option shape. */
export type NotFoundComponentOption =
  | ReactNode
  | ((props: { pathname: string }) => ReactNode);

/**
 * Pick the effective notFound fallback: nearest `notFoundBoundary`, else the
 * router-level `notFound` option, else a plain default.
 *
 * The router option is resolved ONLY when no nearer boundary won — it may be a
 * user render function doing arbitrary work, so computing it eagerly (as three
 * earlier copies of this policy did) burned a full render on every 404 that a
 * boundary was going to handle anyway.
 *
 * Every 404 origin routes through here — segment resolution
 * (`segment-resolution/helpers.ts`), loader-thrown `notFound()`
 * (`loader-resolution.ts`), and the unmatched-route path (`rsc/handler.ts`) —
 * so the default text and the boundary-wins precedence cannot drift apart.
 */
export function resolveNotFoundFallback(
  boundary: ReactNode | NotFoundBoundaryHandler | null | undefined,
  notFoundComponent: NotFoundComponentOption | undefined,
  pathname: string | undefined,
): ReactNode | NotFoundBoundaryHandler {
  if (boundary !== null && boundary !== undefined) return boundary;
  return resolveDefaultNotFound(notFoundComponent, pathname);
}

/**
 * The router-level default alone: `createRouter({ notFound })` rendered, or the
 * plain fallback node. Separate from {@link resolveNotFoundFallback} for the
 * unmatched-route path, which has no entry chain and therefore no boundary to
 * consult — it gets a `ReactNode` back rather than a possible handler.
 */
export function resolveDefaultNotFound(
  notFoundComponent: NotFoundComponentOption | undefined,
  pathname: string | undefined,
): ReactNode {
  if (typeof notFoundComponent === "function") {
    return notFoundComponent({ pathname: pathname ?? "" });
  }
  return notFoundComponent ?? createElement("h1", null, "Not Found");
}

/**
 * Invoke a notFound fallback that may be a boundary handler or a plain node.
 *
 * Callers that cannot propagate a throw (the loader envelope) wrap this in
 * their own try/catch; it deliberately does not swallow, so a throwing boundary
 * still surfaces where that is the correct behavior.
 */
export function renderNotFoundFallback(
  fallback: ReactNode | NotFoundBoundaryHandler,
  notFoundInfo: NotFoundInfo,
): ReactNode {
  if (typeof fallback === "function") {
    return fallback({
      notFound: notFoundInfo,
    } satisfies NotFoundBoundaryFallbackProps);
  }
  return fallback;
}

/**
 * Create a notFound segment with the fallback component
 * Renders the fallback with not found info
 */
export function createNotFoundSegment(
  notFoundInfo: NotFoundInfo,
  fallback: ReactNode | NotFoundBoundaryHandler,
  entry: EntryData,
  params: Record<string, string>,
): ResolvedSegment {
  const component: ReactNode = renderNotFoundFallback(fallback, notFoundInfo);

  return {
    id: `${entry.shortCode}.notFound`,
    namespace: entry.id,
    type: "notFound",
    index: 0,
    component,
    params,
    notFoundInfo,
  };
}
