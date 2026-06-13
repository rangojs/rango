/**
 * Streamed Handler Telemetry
 *
 * Shared fire-and-forget rejection observer for streamed handler promises,
 * used by both the fresh and revalidation segment-resolution paths. Lives in
 * its own module (never mocked) so the resolution unit tests that mock
 * helpers.js / telemetry.js with explicit export lists do not resolve it to
 * undefined.
 */

import type { ReactNode } from "react";
import { getRouterContext } from "../router-context.js";
import { resolveSink, safeEmit } from "../telemetry.js";

/**
 * Attach a fire-and-forget rejection observer to a streamed handler promise.
 * React catches the actual error via its error boundary; this only emits
 * the handler.error telemetry event.
 */
export function observeStreamedHandler(
  promise: Promise<ReactNode>,
  segmentId: string,
  segmentType: string,
  pathname?: string,
  routeKey?: string,
  params?: Record<string, string>,
): void {
  let routerCtx;
  try {
    routerCtx = getRouterContext();
  } catch {
    return;
  }
  if (!routerCtx?.telemetry) return;
  const sink = resolveSink(routerCtx.telemetry);
  const reqId = routerCtx.requestId;
  promise.catch((err: unknown) => {
    const errorObj = err instanceof Error ? err : new Error(String(err));
    safeEmit(sink, {
      type: "handler.error",
      timestamp: performance.now(),
      requestId: reqId,
      segmentId,
      segmentType,
      error: errorObj,
      handledByBoundary: true,
      pathname,
      routeKey,
      params,
    });
  });
}
