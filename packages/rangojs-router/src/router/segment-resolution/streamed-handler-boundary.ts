/**
 * Streamed handlers (loading()): track, observe, and recover a rejection into
 * the declared errorBoundary() / notFoundBoundary() fallback.
 *
 * Invariants:
 * - No status write and no onError call: the status is committed at first
 *   flush, and trackHandler already reports each rejection once.
 * - The recovered promise resolves, so Flight reports no error. The writers
 *   that refuse a failed render through Flight errors need the failure
 *   recorded here: `_renderErrors` for the document cache and a prerender
 *   warm, `_recoveredHandlerErrors` for cacheRoute (cache(), and the doc record
 *   a PPR capture needs). The shell capture and the SWR re-render own both,
 *   so a derived render never writes into (or reads) the foreground's.
 * - Nothing to render to rethrows the original rejection: no boundary found, a
 *   thrown Response (redirect), a Skip, a throwing fallback.
 * - No recovery when `recover` is false (prerender throwOnError, the intercept
 *   background re-render): those lanes must reject so nothing is baked/cached.
 */

import type { ReactNode } from "react";
import { isDataNotFoundError } from "../../errors.js";
import {
  createErrorInfo,
  createNotFoundInfo,
  renderErrorFallback,
  renderNotFoundFallback,
  resolveNotFoundFallback,
} from "../error-handling.js";
import { _getRequestContext } from "../../server/request-context.js";
import type { EntryData } from "../../server/context.js";
import type { ErrorInfo, HandlerContext } from "../../types/index.js";
import type { SegmentResolutionDeps } from "../types.js";
import { observeStreamedHandler } from "./streamed-handler-telemetry.js";

export interface StreamedHandlerOptions<TEnv> {
  /**
   * Entry to look boundaries up from: the matched chain entry being resolved
   * (where the sync path catches, whatever routeless layout owns a slot), or
   * the intercept's declaring entry.
   */
  boundaryEntry: EntryData;
  segmentId: string;
  segmentType: ErrorInfo["segmentType"];
  context: HandlerContext<any, TEnv>;
  routeKey?: string;
  params: Record<string, string>;
  /** False where the rejection must reach the caller (prerender, intercept background re-render). */
  recover: boolean;
}

const NOOP = (): void => {};

/**
 * Track a streamed handler promise and return the segment component: the
 * tracked promise itself when there is nothing to recover to, else a promise
 * that resolves to the declared fallback on rejection.
 */
export function trackStreamedHandler<TEnv>(
  deps: SegmentResolutionDeps<TEnv>,
  result: Promise<unknown>,
  options: StreamedHandlerOptions<TEnv>,
): ReactNode {
  const { segmentId, segmentType, context } = options;
  const tracked = deps.trackHandler(result as Promise<ReactNode>, {
    segmentId,
    segmentType,
  });
  observeStreamedHandler(
    tracked,
    segmentId,
    segmentType,
    context.pathname,
    options.routeKey,
    options.params,
  );

  if (!options.recover) return tracked as ReactNode;
  const { boundaryEntry } = options;
  const hasBoundary =
    deps.findNearestErrorBoundary(boundaryEntry) != null ||
    deps.findNearestNotFoundBoundary(boundaryEntry) != null ||
    deps.notFoundComponent !== undefined;
  if (!hasBoundary) return tracked as ReactNode;

  // Captured now: the rejection can settle outside the request's ALS frame.
  const reqCtx = _getRequestContext();
  const recovered = tracked.catch((error: unknown): ReactNode => {
    const node = renderBoundary(error, deps, options, boundaryEntry);
    if (node === undefined) throw error;
    if (reqCtx)
      (reqCtx._recoveredHandlerErrors ??= new Map()).set(segmentId, error);
    reqCtx?._renderErrors?.push(error);
    return node;
  });
  // A dropped segment (never rendered) must not become an unhandledRejection.
  recovered.catch(NOOP);
  return recovered as ReactNode;
}

function renderBoundary<TEnv>(
  error: unknown,
  deps: SegmentResolutionDeps<TEnv>,
  options: StreamedHandlerOptions<TEnv>,
  boundaryEntry: EntryData,
): ReactNode | undefined {
  if (error instanceof Response) return undefined;
  if ((error as { name?: string } | null)?.name === "Skip") return undefined;
  const { segmentId, segmentType, context } = options;
  try {
    if (isDataNotFoundError(error)) {
      const boundary = deps.findNearestNotFoundBoundary(boundaryEntry);
      if (boundary == null && deps.notFoundComponent === undefined) {
        return undefined;
      }
      return renderNotFoundFallback(
        resolveNotFoundFallback(
          boundary,
          deps.notFoundComponent,
          context.pathname,
        ),
        createNotFoundInfo(error, segmentId, segmentType, context.pathname),
      );
    }
    const fallback = deps.findNearestErrorBoundary(boundaryEntry);
    if (fallback == null) return undefined;
    return renderErrorFallback(
      fallback,
      createErrorInfo(error, segmentId, segmentType),
    );
  } catch {
    return undefined;
  }
}
