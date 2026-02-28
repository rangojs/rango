/**
 * Router Error Handling Utilities
 *
 * Error boundary and not-found boundary handling for RSC Router.
 * Also includes the shared invokeOnError utility for error callback invocation.
 */

import type { ReactNode } from "react";
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
    // Check if this entry has error boundaries defined
    if (current.errorBoundary && current.errorBoundary.length > 0) {
      // Return the last error boundary (most recently defined takes precedence)
      return current.errorBoundary[current.errorBoundary.length - 1];
    }

    // Check orphan layouts for error boundaries
    // Orphan layouts are siblings that render alongside the main route chain
    // They can define error boundaries that catch errors from routes in the same route group
    // Check from first to last (first sibling takes precedence as the "outer" wrapper)
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
    // Check if this entry has notFound boundaries defined
    if (current.notFoundBoundary && current.notFoundBoundary.length > 0) {
      // Return the last notFound boundary (most recently defined takes precedence)
      return current.notFoundBoundary[current.notFoundBoundary.length - 1];
    }
    current = current.parent;
  }

  // Return default notFound boundary if configured
  return defaultNotFoundBoundary || null;
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
      cause: isDev ? error.cause : undefined,
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
  // Determine the component to render
  let component: ReactNode;

  if (typeof fallback === "function") {
    // ErrorBoundaryHandler - call with error info
    const props: ErrorBoundaryFallbackProps = {
      error: errorInfo,
    };
    component = fallback(props);
  } else {
    // Static ReactNode fallback
    component = fallback;
  }

  // Error segment uses the same ID as the layout that has the error boundary
  // The error boundary content replaces the layout's outlet content
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
  // Determine the component to render
  let component: ReactNode;

  if (typeof fallback === "function") {
    // NotFoundBoundaryHandler - call with props
    const props: NotFoundBoundaryFallbackProps = {
      notFound: notFoundInfo,
    };
    component = fallback(props);
  } else {
    // Static ReactNode fallback
    component = fallback;
  }

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
