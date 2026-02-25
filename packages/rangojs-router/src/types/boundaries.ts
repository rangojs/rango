import type { ReactNode } from "react";

/**
 * Error information passed to error boundary fallback components
 */
export interface ErrorInfo {
  /** Error message (always available) */
  message: string;
  /** Error name/type (e.g., "RouteNotFoundError", "MiddlewareError") */
  name: string;
  /** Optional error code for programmatic handling */
  code?: string;
  /** Stack trace (only in development) */
  stack?: string;
  /** Original error cause if available */
  cause?: unknown;
  /** Segment ID where the error occurred */
  segmentId: string;
  /** Segment type where the error occurred */
  segmentType:
    | "layout"
    | "route"
    | "parallel"
    | "loader"
    | "middleware"
    | "cache";
}

/**
 * Props passed to server-side error boundary fallback components
 *
 * Server error boundaries don't have a reset function since the error
 * occurred during server rendering. Users can navigate away or refresh.
 *
 * @example
 * ```typescript
 * function ProductErrorFallback({ error }: ErrorBoundaryFallbackProps) {
 *   return (
 *     <div>
 *       <h2>Something went wrong loading the product</h2>
 *       <p>{error.message}</p>
 *       <a href="/">Go home</a>
 *     </div>
 *   );
 * }
 * ```
 */
export interface ErrorBoundaryFallbackProps {
  /** Error information */
  error: ErrorInfo;
}

/**
 * Error boundary handler - receives error info and returns fallback UI
 */
export type ErrorBoundaryHandler = (
  props: ErrorBoundaryFallbackProps,
) => ReactNode;

/**
 * Props passed to client-side error boundary fallback components
 *
 * Client error boundaries have a reset function that clears the error state
 * and re-renders the children.
 *
 * @example
 * ```typescript
 * function ClientErrorFallback({ error, reset }: ClientErrorBoundaryFallbackProps) {
 *   return (
 *     <div>
 *       <h2>Something went wrong</h2>
 *       <p>{error.message}</p>
 *       <button onClick={reset}>Try again</button>
 *     </div>
 *   );
 * }
 * ```
 */
export interface ClientErrorBoundaryFallbackProps {
  /** Error information */
  error: ErrorInfo;
  /** Function to reset error state and retry rendering */
  reset: () => void;
}

/**
 * Wrapped loader data result for deferred resolution with error handling.
 * When loaders are deferred to client-side resolution, errors need to be
 * wrapped so the client can handle them appropriately.
 */
export type LoaderDataResult<T = unknown> =
  | { __loaderResult: true; ok: true; data: T }
  | {
      __loaderResult: true;
      ok: false;
      error: ErrorInfo;
      fallback: ReactNode | null;
    };

/**
 * Type guard to check if a value is a wrapped loader result
 */
export function isLoaderDataResult(value: unknown): value is LoaderDataResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "__loaderResult" in value &&
    (value as any).__loaderResult === true
  );
}

/**
 * Not found information passed to notFound boundary fallback components
 */
export interface NotFoundInfo {
  /** Not found message */
  message: string;
  /** Segment ID where notFound was thrown */
  segmentId: string;
  /** Segment type where notFound was thrown */
  segmentType:
    | "layout"
    | "route"
    | "parallel"
    | "loader"
    | "middleware"
    | "cache";
  /** The pathname that triggered the not found */
  pathname?: string;
}

/**
 * Props passed to notFound boundary fallback components
 *
 * @example
 * ```typescript
 * function ProductNotFound({ notFound }: NotFoundBoundaryFallbackProps) {
 *   return (
 *     <div>
 *       <h2>Product Not Found</h2>
 *       <p>{notFound.message}</p>
 *       <a href="/products">Browse all products</a>
 *     </div>
 *   );
 * }
 * ```
 */
export interface NotFoundBoundaryFallbackProps {
  /** Not found information */
  notFound: NotFoundInfo;
}

/**
 * NotFound boundary handler - receives not found info and returns fallback UI
 */
export type NotFoundBoundaryHandler = (
  props: NotFoundBoundaryFallbackProps,
) => ReactNode;
