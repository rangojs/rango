import type { ReactNode } from "react";
import { sanitizeError } from "../errors";
import type { ErrorInfo, ErrorPhase, MatchResult } from "../types";
import type {
  EntryData,
  InterceptEntry,
  InterceptSelectorContext,
} from "../server/context";
import type { MatchApiDeps } from "./types.js";
import type { RouterContext } from "./router-context.js";
import { runWithRouterContext } from "./router-context.js";
import {
  type ActionContext,
  type MatchContext,
  createPipelineState,
} from "./match-context.js";
import { createMatchPartialPipeline } from "./match-pipelines.js";
import { collectMatchResult } from "./match-result.js";
import {
  createMatchContextForFull as _createMatchContextForFull,
  createMatchContextForPartial as _createMatchContextForPartial,
  matchError as _matchError,
} from "./match-api.js";
import { previewMatch as _previewMatch } from "./preview-match.js";
import {
  runWithRouterLogContext,
  withRouterLogScope,
  isRouterDebugEnabled,
  startRevalidationTrace,
  flushRevalidationTrace,
} from "./logging.js";
import type { ErrorBoundaryHandler, NotFoundBoundaryHandler } from "../types";
import type { MiddlewareFn } from "./middleware.js";
import {
  type TelemetrySink,
  type CacheSegmentSignal,
  safeEmit,
  resolveSink,
  getRequestId,
  buildCacheSignalSegments,
} from "./telemetry.js";
import { _getRequestContext } from "../server/request-context.js";

export interface MatchHandlerDeps<TEnv = any> {
  buildRouterContext: () => RouterContext<TEnv>;
  callOnError: (error: unknown, phase: ErrorPhase, context: any) => void;
  matchApiDeps: MatchApiDeps<TEnv>;
  defaultErrorBoundary: ReactNode | ErrorBoundaryHandler | undefined;
  findMatch: (pathname: string, ms?: any) => any;
  findInterceptForRoute: (
    routeKey: string,
    parentEntry: EntryData | null,
    selectorContext: InterceptSelectorContext | null,
    isAction: boolean,
  ) => { intercept: InterceptEntry; entry: EntryData } | null;
  telemetry?: TelemetrySink;
  /**
   * DEVELOPMENT/TEST ONLY gate for the X-Rango-Cache debug header. When true,
   * match/matchPartial stash a coarse route-level cache signal on the request
   * context for the response-finalization path to emit. Default off.
   */
  cacheSignalEnabled?: boolean;
}

export interface MatchHandlers<TEnv = any> {
  match: (request: Request, env: TEnv) => Promise<MatchResult>;
  matchPartial: (
    request: Request,
    context: TEnv,
    actionContext?: ActionContext,
  ) => Promise<MatchResult | null>;
  matchError: (
    request: Request,
    _context: TEnv,
    error: unknown,
    segmentType?: ErrorInfo["segmentType"],
  ) => Promise<MatchResult | null>;
  previewMatch: (
    request: Request,
    _context: TEnv,
  ) => Promise<{
    routeMiddleware?: Array<{
      handler: MiddlewareFn;
      params: Record<string, string>;
    }>;
    responseType?: string;
    handler?: Function;
    params?: Record<string, string>;
    negotiated?: boolean;
    manifestEntry?: EntryData;
  } | null>;
}

/**
 * Create match handler functions bound to router closure state.
 * These are the main request-handling entry points for SSR, navigation,
 * error recovery, and preview matching.
 */
export function createMatchHandlers<TEnv = any>(
  deps: MatchHandlerDeps<TEnv>,
): MatchHandlers<TEnv> {
  const {
    buildRouterContext,
    callOnError,
    matchApiDeps,
    defaultErrorBoundary,
    findInterceptForRoute,
  } = deps;
  const hasTelemetry = !!deps.telemetry;
  const telemetry = resolveSink(deps.telemetry);
  const cacheSignalEnabled = !!deps.cacheSignalEnabled;
  const buildSignal = (
    routeKey: string,
    state: {
      cacheHit: boolean;
      cacheSource?: "runtime" | "prerender";
      shouldRevalidate?: boolean;
    },
  ): CacheSegmentSignal[] => buildCacheSignalSegments(routeKey, state);
  const recordSignalIfEnabled = (segments: CacheSegmentSignal[]): void => {
    if (!cacheSignalEnabled) return;
    const reqCtx = _getRequestContext();
    if (reqCtx) reqCtx._cacheSignal = segments;
  };

  async function createMatchContextForFull(
    request: Request,
    env: TEnv,
  ): Promise<MatchContext<TEnv> | { type: "redirect"; redirectUrl: string }> {
    return _createMatchContextForFull(
      request,
      env,
      matchApiDeps,
      findInterceptForRoute,
    );
  }

  async function createMatchContextForPartial(
    request: Request,
    env: TEnv,
    actionContext?: {
      actionId?: string;
      actionUrl?: URL;
      actionResult?: any;
      formData?: FormData;
    },
  ): Promise<MatchContext<TEnv> | null> {
    return _createMatchContextForPartial(
      request,
      env,
      matchApiDeps,
      findInterceptForRoute,
      actionContext,
    );
  }

  async function match(request: Request, env: TEnv): Promise<MatchResult> {
    const requestId = hasTelemetry ? getRequestId(request) : undefined;
    return runWithRouterLogContext({ request, transaction: "match" }, () => {
      const routerCtx = buildRouterContext();
      routerCtx.requestId = requestId;
      return runWithRouterContext(routerCtx, async () =>
        withRouterLogScope("match", async () => {
          const matchStart = performance.now();
          const pathname = new URL(request.url).pathname;
          if (hasTelemetry) {
            safeEmit(telemetry, {
              type: "request.start",
              timestamp: matchStart,
              requestId,
              method: request.method,
              pathname,
              transaction: "match",
              isPartial: false,
            });
          }

          const result = await createMatchContextForFull(request, env);

          if ("type" in result && result.type === "redirect") {
            if (hasTelemetry) {
              safeEmit(telemetry, {
                type: "request.end",
                timestamp: performance.now(),
                requestId,
                method: request.method,
                pathname,
                transaction: "match",
                durationMs: performance.now() - matchStart,
                segmentCount: 0,
                cacheHit: false,
              });
            }
            return {
              segments: [],
              matched: [],
              diff: [],
              resolvedIds: [],
              params: {},
              redirect: result.redirectUrl,
            };
          }

          const ctx = result as MatchContext<TEnv>;

          try {
            const state = createPipelineState();
            const pipeline = createMatchPartialPipeline(ctx, state);
            const matchResult = await collectMatchResult(pipeline, ctx, state);
            if (hasTelemetry || cacheSignalEnabled) {
              const signalSegments = buildSignal(ctx.routeKey, state);
              recordSignalIfEnabled(signalSegments);
              if (hasTelemetry) {
                safeEmit(telemetry, {
                  type: "cache.decision",
                  timestamp: performance.now(),
                  requestId,
                  pathname,
                  routeKey: ctx.routeKey,
                  hit: state.cacheHit,
                  shouldRevalidate: !!state.shouldRevalidate,
                  source: state.cacheSource,
                  segments: signalSegments,
                });
              }
            }
            if (hasTelemetry) {
              safeEmit(telemetry, {
                type: "request.end",
                timestamp: performance.now(),
                requestId,
                method: request.method,
                pathname,
                transaction: "match",
                durationMs: performance.now() - matchStart,
                segmentCount: matchResult.segments.length,
                cacheHit: state.cacheHit,
              });
            }
            return matchResult;
          } catch (error) {
            if (hasTelemetry) {
              const errorObj =
                error instanceof Error ? error : new Error(String(error));
              safeEmit(telemetry, {
                type: "request.error",
                timestamp: performance.now(),
                requestId,
                method: request.method,
                pathname,
                transaction: "match",
                error: errorObj,
                phase: error instanceof Response ? "redirect" : "routing",
                durationMs: performance.now() - matchStart,
              });
            }
            if (error instanceof Response) throw error;
            callOnError(error, "routing", {
              request,
              url: ctx.url,
              env,
              isPartial: false,
              handledByBoundary: false,
            });
            throw sanitizeError(error);
          }
        }),
      );
    });
  }

  async function matchError(
    request: Request,
    _context: TEnv,
    error: unknown,
    segmentType: ErrorInfo["segmentType"] = "route",
  ): Promise<MatchResult | null> {
    return runWithRouterLogContext({ request, transaction: "matchError" }, () =>
      withRouterLogScope("matchError", () =>
        _matchError(
          request,
          _context,
          error,
          matchApiDeps,
          defaultErrorBoundary,
          segmentType,
        ),
      ),
    );
  }

  async function matchPartial(
    request: Request,
    context: TEnv,
    actionContext?: ActionContext,
  ): Promise<MatchResult | null> {
    const partialRequestId = hasTelemetry ? getRequestId(request) : undefined;
    return runWithRouterLogContext(
      { request, transaction: "matchPartial" },
      () => {
        const routerCtx = buildRouterContext();
        routerCtx.requestId = partialRequestId;
        return runWithRouterContext(routerCtx, async () =>
          withRouterLogScope("matchPartial", async () => {
            const matchStart = performance.now();
            const pathname = new URL(request.url).pathname;
            if (hasTelemetry) {
              safeEmit(telemetry, {
                type: "request.start",
                timestamp: matchStart,
                requestId: partialRequestId,
                method: request.method,
                pathname,
                transaction: "matchPartial",
                isPartial: true,
              });
            }

            const ctx = await createMatchContextForPartial(
              request,
              context,
              actionContext,
            );
            if (!ctx) {
              if (hasTelemetry) {
                safeEmit(telemetry, {
                  type: "request.end",
                  timestamp: performance.now(),
                  requestId: partialRequestId,
                  method: request.method,
                  pathname,
                  transaction: "matchPartial",
                  durationMs: performance.now() - matchStart,
                  segmentCount: 0,
                  cacheHit: false,
                });
              }
              return null;
            }

            if (isRouterDebugEnabled()) {
              startRevalidationTrace({
                method: request.method,
                prevUrl: ctx.prevUrl.href,
                nextUrl: ctx.url.href,
                routeKey: ctx.routeKey,
                isAction: !!actionContext,
                stale: ctx.stale || undefined,
              });
            }

            try {
              const state = createPipelineState();
              const pipeline = createMatchPartialPipeline(ctx, state);
              const matchResult = await collectMatchResult(
                pipeline,
                ctx,
                state,
              );
              flushRevalidationTrace();
              if (hasTelemetry || cacheSignalEnabled) {
                const signalSegments = buildSignal(ctx.routeKey, state);
                recordSignalIfEnabled(signalSegments);
                if (hasTelemetry) {
                  safeEmit(telemetry, {
                    type: "cache.decision",
                    timestamp: performance.now(),
                    requestId: partialRequestId,
                    pathname,
                    routeKey: ctx.routeKey,
                    hit: state.cacheHit,
                    shouldRevalidate: !!state.shouldRevalidate,
                    source: state.cacheSource,
                    segments: signalSegments,
                  });
                }
              }
              if (hasTelemetry) {
                safeEmit(telemetry, {
                  type: "request.end",
                  timestamp: performance.now(),
                  requestId: partialRequestId,
                  method: request.method,
                  pathname,
                  transaction: "matchPartial",
                  durationMs: performance.now() - matchStart,
                  segmentCount: matchResult.segments.length,
                  cacheHit: state.cacheHit,
                });
              }
              return matchResult;
            } catch (error) {
              flushRevalidationTrace();
              if (hasTelemetry) {
                const errorObj =
                  error instanceof Error ? error : new Error(String(error));
                const phase = actionContext ? "action" : "revalidation";
                safeEmit(telemetry, {
                  type: "request.error",
                  timestamp: performance.now(),
                  requestId: partialRequestId,
                  method: request.method,
                  pathname,
                  transaction: "matchPartial",
                  error: errorObj,
                  phase: error instanceof Response ? "redirect" : phase,
                  durationMs: performance.now() - matchStart,
                });
              }
              if (error instanceof Response) throw error;
              callOnError(error, actionContext ? "action" : "revalidation", {
                request,
                url: ctx.url,
                env: context,
                actionId: actionContext?.actionId,
                isPartial: true,
                handledByBoundary: false,
              });
              throw sanitizeError(error);
            }
          }),
        );
      },
    );
  }

  async function previewMatch(
    request: Request,
    _context: TEnv,
  ): ReturnType<typeof _previewMatch> {
    return _previewMatch(request, _context, { findMatch: deps.findMatch });
  }

  return {
    match: match,
    matchPartial: matchPartial,
    matchError: matchError,
    previewMatch: previewMatch,
  };
}
