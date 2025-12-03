/**
 * Router Error Handling Utilities
 *
 * Error boundary and not-found boundary handling for RSC Router.
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
} from "../types";

/**
 * Find the nearest error boundary by walking up the entry chain
 * Also checks sibling layouts (orphan layouts) for error boundaries
 * Returns the first fallback found, or the default error boundary if configured
 */
export function findNearestErrorBoundary(
  entry: EntryData | null,
  defaultErrorBoundary?: ReactNode | ErrorBoundaryHandler
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
  defaultNotFoundBoundary?: ReactNode | NotFoundBoundaryHandler
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
  segmentType: ErrorInfo["segmentType"]
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
  params: Record<string, string>
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
  pathname?: string
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
  params: Record<string, string>
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
