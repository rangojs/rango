import { NetworkError, isNetworkError } from "../errors.js";
import { NetworkErrorThrower } from "../network-error-thrower.js";
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
 * Emit a NetworkError to the UI via the onUpdate subscriber.
 * Wraps in startTransition and renders a NetworkErrorThrower component
 * that throws during render to trigger the nearest error boundary.
 */
export function emitNetworkError(
  onUpdate: UpdateSubscriber,
  error: NetworkError,
  pathname: string,
): void {
  startTransition(() => {
    onUpdate({
      root: createElement(NetworkErrorThrower, { error }),
      metadata: {
        pathname,
        segments: [],
        isError: true,
      },
    });
  });
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
