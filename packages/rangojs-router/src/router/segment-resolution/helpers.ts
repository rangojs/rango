/**
 * Shared Helpers for Segment Resolution
 *
 * Common utilities used by both fresh and revalidation resolution paths:
 * - Handler result processing (Response vs ReactNode)
 * - Static handler interception (build-time pre-rendered components)
 * - Layout handler resolution with static fallback
 * - Error boundary segment creation
 */

import type { ReactNode } from "react";
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
import { resolveSink, safeEmit } from "../telemetry.js";

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
        segmentId: entry.shortCode,
        segmentType: entry.type,
        error: errorObj,
        handledByBoundary,
      });
    }
  };

  const setResponseStatus = (status: number) => {
    const reqCtx = getRequestContext();
    if (reqCtx) {
      reqCtx.setStatus(status);
    }
  };

  if (error instanceof DataNotFoundError) {
    const notFoundFallback = deps.findNearestNotFoundBoundary(entry);

    if (notFoundFallback) {
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
        notFoundFallback,
        entry,
        params,
      );
    }
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
): Promise<TResult> {
  try {
    return await resolveFn();
  } catch (error) {
    if (error instanceof Response) throw error;
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
