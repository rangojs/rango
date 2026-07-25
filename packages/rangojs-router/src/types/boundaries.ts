import type { ReactNode } from "react";

export interface ErrorInfo {
  message: string;
  name: string;
  code?: string;
  stack?: string;
  cause?: unknown;
  segmentId: string;
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
  error: ErrorInfo;
}

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
  error: ErrorInfo;
  reset: () => void;
}

export type LoaderDataResult<T = unknown> =
  | { __loaderResult: true; ok: true; data: T }
  | {
      __loaderResult: true;
      ok: false;
      error: ErrorInfo;
      fallback: ReactNode | null;
      /**
       * Loader threw notFound() (DataNotFoundError). `fallback` carries the
       * SERVER-RENDERED not-found UI (nearest notFoundBoundary → router
       * notFound option → default), so the client swaps to 404 presentation
       * with zero extra round trips. Routed by decodeLoaderEntry via
       * LOADER_NOT_FOUND_FALLBACK, not the error-fallback marker.
       */
      notFound?: true;
      /**
       * Loader threw redirect(...) (a 3xx Response). `to` is resolved through
       * the soft-redirect same-origin rules BEFORE leaving the server
       * (resolveSoftRedirectUrl), so unsafe targets never reach the wire. The
       * client navigates (replace) when the entry decodes.
       */
      redirect?: { to: string };
    };

export function isLoaderDataResult(value: unknown): value is LoaderDataResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "__loaderResult" in value &&
    (value as any).__loaderResult === true
  );
}

export interface NotFoundInfo {
  message: string;
  segmentId: string;
  segmentType:
    | "layout"
    | "route"
    | "parallel"
    | "loader"
    | "middleware"
    | "cache";
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
  notFound: NotFoundInfo;
}

export type NotFoundBoundaryHandler = (
  props: NotFoundBoundaryFallbackProps,
) => ReactNode;
