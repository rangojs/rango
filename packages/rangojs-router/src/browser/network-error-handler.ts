import { NetworkError, isNetworkError } from "../errors.js";
import { RenderErrorThrower } from "../render-error-thrower.js";
import type { UpdateSubscriber } from "./types.js";
import { createElement, startTransition } from "react";

/**
 * Convert an unknown error to a NetworkError, or return null if not network-related.
 *
 * Pure function: extracts the "is this a network error?" decision from
 * navigation-bridge and server-action-bridge so it can be unit tested.
 */
export function toNetworkError(
  error: unknown,
  context: { url: string; operation: "action" | "navigation" | "revalidation" },
): NetworkError | null {
  if (error instanceof NetworkError) return error;
  if (isNetworkError(error)) {
    return new NetworkError(
      "Unable to connect to server. Please check your connection.",
      { cause: error, url: context.url, operation: context.operation },
    );
  }
  return null;
}

/**
 * Render an error into the segment tree via the onUpdate subscriber so the
 * nearest error boundary catches it. Wrapped in startTransition; RenderErrorThrower
 * throws during render (async rejections do not reach boundaries on their own).
 */
function emitErrorToBoundary(
  onUpdate: UpdateSubscriber,
  error: unknown,
  pathname: string,
): void {
  startTransition(() => {
    onUpdate({
      root: createElement(RenderErrorThrower, { error }),
      metadata: {
        pathname,
        segments: [],
        isError: true,
      },
    });
  });
}

/**
 * Emit a NetworkError to the nearest error boundary (offline, failed fetch).
 */
export function emitNetworkError(
  onUpdate: UpdateSubscriber,
  error: NetworkError,
  pathname: string,
): void {
  emitErrorToBoundary(onUpdate, error, pathname);
}

/**
 * Emit a navigation processing error to the nearest error boundary. Used when a
 * navigation response cannot be processed (an undecodable Flight body, or any
 * unanticipated failure while building the response) -- for both fresh and
 * prefetched responses, since both funnel through the navigation catch. Without
 * this, such a failure becomes an uncaught rejection that silently aborts the
 * navigation instead of surfacing the route's error boundary.
 */
export function emitNavigationError(
  onUpdate: UpdateSubscriber,
  error: unknown,
  pathname: string,
): void {
  emitErrorToBoundary(onUpdate, error, pathname);
}

/**
 * Check if an error is safe to suppress in background operations.
 *
 * Background revalidation (SWR, navigated-away refetch) should silently
 * swallow AbortErrors and network errors since the user has already moved
 * on and showing an error would be disruptive.
 *
 * Pure function, easily unit tested.
 */
export function isBackgroundSuppressible(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof NetworkError || isNetworkError(error)) return true;
  return false;
}
