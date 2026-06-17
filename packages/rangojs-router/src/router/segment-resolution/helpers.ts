/**
 * Shared Helpers for Segment Resolution
 *
 * Common utilities used by both fresh and revalidation resolution paths:
 * - Handler result processing (Response vs ReactNode)
 * - Static handler interception (build-time pre-rendered components)
 * - Layout handler resolution with static fallback
 * - Error boundary segment creation
 */

import { createElement, type ReactNode } from "react";
import { DataNotFoundError } from "../../errors";
import {
  createErrorInfo,
  createErrorSegment,
  createNotFoundInfo,
  createNotFoundSegment,
} from "../error-handling.js";
import { getRequestContext } from "../../server/request-context.js";
import { DefaultErrorFallback } from "../../default-error-boundary.js";
import type { EntryData } from "../../server/context";
import type { ResolvedSegment, ErrorInfo, HandlerContext } from "../../types";
import type { SegmentResolutionDeps } from "../types.js";
import { debugLog } from "../logging.js";
import { tryStaticLookup } from "./static-store.js";
import type { TelemetrySink } from "../telemetry.js";
import { resolveSink, safeEmit, getRequestId } from "../telemetry.js";

// ---------------------------------------------------------------------------
// Handler result processing
// ---------------------------------------------------------------------------

/**
 * Handle Response returns from handlers.
 * When a handler returns a Response (e.g., redirect), throw it to trigger
 * the short-circuit mechanism. Otherwise return the ReactNode.
 */
export function handleHandlerResult(
  result: ReactNode | Response | Promise<ReactNode> | Promise<Response>,
): ReactNode {
  if (result instanceof Response) {
    throw result;
  }
  if (result instanceof Promise) {
    return result.then((resolved) => {
      if (resolved instanceof Response) {
        throw resolved;
      }
      return resolved;
    }) as ReactNode;
  }
  return result;
}

/**
 * Dev-only: warn when a handler on a route that declares loading() resolves or
 * rejects with a Response (e.g. redirect()).
 *
 * On a non-loading route a returned/thrown Response short-circuits to an HTTP
 * redirect. But when the route declares loading(), the handler result is
 * streamed (not awaited at the resolution boundary), so the Response surfaces
 * only during RSC serialization and is rendered into the stream instead of
 * becoming a 302/308 — a silent failure mode. Issue redirects from middleware,
 * a loader, or a synchronous handler return instead. Compiled out in production.
 */
export function warnOnStreamedResponse(
  result: Promise<unknown>,
  entryId: string,
): void {
  if (process.env.NODE_ENV === "production") return;
  // A Response can surface either as a rejection (handleHandlerResult rethrows a
  // resolved Response) or as a resolved value (the raw parallel-slot handler is
  // not run through handleHandlerResult). Check both so every streamed path is
  // covered. Each handler is an independent observer; it does not consume the
  // rejection for the trackHandler/observeStreamedHandler chains.
  const check = (value: unknown) => {
    if (value instanceof Response) {
      console.warn(
        `[rango] Handler for "${entryId}" returned a Response (e.g. ` +
          `redirect()), but it declares loading(): the Response is rendered ` +
          `into the RSC stream, NOT sent as an HTTP redirect. Issue redirects ` +
          `from middleware, a loader, or a synchronous handler return.`,
      );
    }
  };
  result.then(check, check);
}

// ---------------------------------------------------------------------------
// Static handler interception
// ---------------------------------------------------------------------------

/**
 * Try to resolve a component from the build-time static store.
 * Returns undefined synchronously when the entry is not a static prerender,
 * avoiding unnecessary promise wrapping on the hot path.
 */
export function tryStaticHandler(
  entry: EntryData,
  segmentId: string,
): Promise<ReactNode | undefined> | undefined {
  const entryAny = entry as any;
  if (entryAny.isStaticPrerender && entryAny.staticHandlerId) {
    return tryStaticLookup(entryAny.staticHandlerId, segmentId);
  }
  return undefined;
}

/**
 * Try to resolve a parallel slot component from the build-time static store.
 * Returns undefined synchronously when no static handler ID exists for the slot.
 */
export function tryStaticSlot(
  parallelEntry: EntryData,
  slot: string,
  segmentId: string,
): Promise<ReactNode | undefined> | undefined {
  const slotStaticId = (parallelEntry as any).staticHandlerIds?.[slot];
  if (slotStaticId) {
    return tryStaticLookup(slotStaticId, segmentId);
  }
  return undefined;
}

/**
 * Resolve a layout or cache entry's handler component.
 * Checks build-time static store first, then invokes the handler.
 */
export async function resolveLayoutComponent<TEnv>(
  entry: EntryData,
  context: HandlerContext<any, TEnv>,
): Promise<ReactNode> {
  const component = await tryStaticHandler(entry, entry.shortCode);
  if (component !== undefined) return component;
  return typeof entry.handler === "function"
    ? handleHandlerResult(await entry.handler(context))
    : (entry.handler as ReactNode);
}

// ---------------------------------------------------------------------------
// Error boundary segment creation
// ---------------------------------------------------------------------------

/**
 * Context for error reporting in segment resolution.
 * When provided, callOnError is invoked with this context.
 */
export interface ErrorReportContext {
  request?: Request;
  url?: URL;
  routeKey?: string;
  env?: any;
  isPartial?: boolean;
  requestStartTime?: number;
  telemetry?: TelemetrySink;
}

/**
 * Handle a caught error during segment resolution by creating an
 * error or not-found segment with the nearest boundary.
 *
 * Called by resolveWithErrorBoundary to produce error/notFound segments.
 */
export function catchSegmentError<TEnv>(
  error: unknown,
  entry: EntryData,
  params: Record<string, string>,
  deps: SegmentResolutionDeps<TEnv>,
  report?: ErrorReportContext,
  pathname?: string,
): ResolvedSegment {
  const reportError = (
    handledByBoundary: boolean,
    metadata?: Record<string, unknown>,
  ) => {
    if (!report) return;
    deps.callOnError(error, "handler", {
      request: report.request as Request,
      url: report.url,
      routeKey: report.routeKey,
      params,
      segmentId: entry.shortCode,
      segmentType: entry.type as any,
      env: report.env,
      isPartial: report.isPartial,
      handledByBoundary,
      metadata,
      requestStartTime: report.requestStartTime,
    });
    if (report.telemetry) {
      const errorObj =
        error instanceof Error ? error : new Error(String(error));
      safeEmit(resolveSink(report.telemetry), {
        type: "handler.error",
        timestamp: performance.now(),
        requestId: report.request ? getRequestId(report.request) : undefined,
        segmentId: entry.shortCode,
        segmentType: entry.type,
        error: errorObj,
        handledByBoundary,
        pathname,
        routeKey: report.routeKey,
        params,
      });
    }
  };

  const setResponseStatus = (status: number) => {
    const reqCtx = getRequestContext();
    if (reqCtx) {
      reqCtx._setStatus(status);
    }
  };

  if (error instanceof DataNotFoundError) {
    const notFoundFallback = deps.findNearestNotFoundBoundary(entry);
    // Fall back to router's notFound component, then a plain default
    const notFoundOption = deps.notFoundComponent;
    const defaultFallback =
      typeof notFoundOption === "function"
        ? notFoundOption({ pathname: pathname ?? "" })
        : (notFoundOption ?? createElement("h1", null, "Not Found"));
    const effectiveNotFoundFallback = notFoundFallback ?? defaultFallback;

    const notFoundInfo = createNotFoundInfo(
      error,
      entry.shortCode,
      entry.type,
      pathname,
    );

    reportError(true, {
      notFound: true,
      message: notFoundInfo.message,
    });

    debugLog("segment", "notFound boundary handled error", {
      segmentId: entry.shortCode,
      message: notFoundInfo.message,
    });

    setResponseStatus(404);

    return createNotFoundSegment(
      notFoundInfo,
      effectiveNotFoundFallback,
      entry,
      params,
    );
  }

  const fallback = deps.findNearestErrorBoundary(entry);
  const segmentType: ErrorInfo["segmentType"] = entry.type;
  const errorInfo = createErrorInfo(error, entry.shortCode, segmentType);
  const effectiveFallback = fallback ?? DefaultErrorFallback;

  reportError(!!effectiveFallback);

  debugLog("segment", "error boundary handled error", {
    segmentId: entry.shortCode,
    boundary: fallback ? "custom" : "default",
    message: errorInfo.message,
  });

  setResponseStatus(500);

  return createErrorSegment(errorInfo, effectiveFallback, entry, params);
}

/**
 * Generic error boundary wrapper for segment resolution.
 * Catches non-Response errors and produces an error/notFound segment
 * via catchSegmentError. Response throws (e.g. redirects) are re-thrown.
 *
 * The caller provides a `wrapError` callback to shape the error segment
 * into the expected return type (e.g. ResolvedSegment[] for the fresh
 * path, or SegmentRevalidationResult for the revalidation path).
 */
export async function resolveWithErrorBoundary<TEnv, TResult>(
  entry: EntryData,
  params: Record<string, string>,
  resolveFn: () => Promise<TResult>,
  wrapError: (segment: ResolvedSegment) => TResult,
  deps: SegmentResolutionDeps<TEnv>,
  report?: ErrorReportContext,
  pathname?: string,
  throwOnError?: boolean,
): Promise<TResult> {
  try {
    return await resolveFn();
  } catch (error) {
    if (error instanceof Response) throw error;
    // Pre-render surfaces render failures to the build instead of baking the
    // error boundary as a frozen 200 (issue #587). A `throw new Skip()` in a
    // render fn also propagates here so the build can skip that URL rather than
    // bake its error page. The live request path leaves throwOnError unset.
    if (throwOnError) throw error;
    const segment = catchSegmentError(
      error,
      entry,
      params,
      deps,
      report,
      pathname,
    );
    return wrapError(segment);
  }
}
