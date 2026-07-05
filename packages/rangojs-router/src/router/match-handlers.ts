import type { ReactNode } from "react";
import { INTERNAL_RANGO_DEBUG } from "../internal-debug.js";
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

/**
 * Per-call telemetry lifecycle emitter for match()/matchPartial(). Each method
 * reproduces the exact event object the two functions used to emit inline and is
 * gated on the same per-call flag (`enabled` = the request's `emitTelemetry`), so
 * a PPR shell-capture run (enabled=false) emits nothing while a foreground run
 * emits byte-identical events. Extracted so the two transactions can't drift;
 * pinned by thrown-response-telemetry.test.ts and
 * shell-capture-telemetry-suppression.test.ts.
 */
interface LifecycleEmitter {
  start(): void;
  end(segmentCount: number, cacheHit: boolean, status?: number): void;
  cacheDecision(
    routeKey: string,
    state: {
      cacheHit: boolean;
      cacheSource?: "runtime" | "prerender";
      shouldRevalidate?: boolean;
    },
    segments: CacheSegmentSignal[],
  ): void;
  error(error: Error, phase: string): void;
}

function createLifecycleEmitter(args: {
  enabled: boolean;
  sink: TelemetrySink;
  requestId: string | undefined;
  method: string;
  pathname: string;
  transaction: "match" | "matchPartial";
  isPartial: boolean;
  matchStart: number;
}): LifecycleEmitter {
  return {
    start(): void {
      if (!args.enabled) return;
      safeEmit(args.sink, {
        type: "request.start",
        timestamp: args.matchStart,
        requestId: args.requestId,
        method: args.method,
        pathname: args.pathname,
        transaction: args.transaction,
        isPartial: args.isPartial,
      });
    },
    end(segmentCount: number, cacheHit: boolean, status?: number): void {
      if (!args.enabled) return;
      safeEmit(args.sink, {
        type: "request.end",
        timestamp: performance.now(),
        requestId: args.requestId,
        method: args.method,
        pathname: args.pathname,
        transaction: args.transaction,
        durationMs: performance.now() - args.matchStart,
        segmentCount,
        cacheHit,
        // Only a thrown-Response short-circuit passes a status; a normal render
        // completion omits it (the Response is built after match()).
        ...(status !== undefined && { status }),
      });
    },
    cacheDecision(
      routeKey: string,
      state: {
        cacheHit: boolean;
        cacheSource?: "runtime" | "prerender";
        shouldRevalidate?: boolean;
      },
      segments: CacheSegmentSignal[],
    ): void {
      if (!args.enabled) return;
      safeEmit(args.sink, {
        type: "cache.decision",
        timestamp: performance.now(),
        requestId: args.requestId,
        pathname: args.pathname,
        routeKey,
        hit: state.cacheHit,
        shouldRevalidate: !!state.shouldRevalidate,
        source: state.cacheSource,
        segments,
      });
    },
    error(error: Error, phase: string): void {
      if (!args.enabled) return;
      safeEmit(args.sink, {
        type: "request.error",
        timestamp: performance.now(),
        requestId: args.requestId,
        method: args.method,
        pathname: args.pathname,
        transaction: args.transaction,
        error,
        phase,
        durationMs: performance.now() - args.matchStart,
      });
    },
  };
}

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
    // Silence telemetry for the PPR background shell capture: it re-runs match()
    // under a derived request context flagged _shellCaptureRun (shell-capture.ts
    // attemptCapture), re-using the foreground Request — a second request.start/
    // cache.decision/request.end stamped with the same WeakMap-keyed requestId
    // would double-count dashboards. Derived here (inside the capture's active
    // request-context ALS) so the read sees the derived context, not module state.
    const emitTelemetry =
      hasTelemetry && !_getRequestContext()?._shellCaptureRun;
    const requestId = emitTelemetry ? getRequestId(request) : undefined;
    return runWithRouterLogContext({ request, transaction: "match" }, () => {
      const routerCtx = buildRouterContext();
      // Also mute in-pipeline observeEvent emitters (revalidation.decision,
      // cache-lookup's cache.decision) which read routerCtx.telemetry.
      if (!emitTelemetry) routerCtx.telemetry = undefined;
      routerCtx.requestId = requestId;
      return runWithRouterContext(routerCtx, async () =>
        withRouterLogScope("match", async () => {
          const matchStart = performance.now();
          const pathname =
            _getRequestContext()?.url?.pathname ??
            new URL(request.url).pathname;
          const emitter = createLifecycleEmitter({
            enabled: emitTelemetry,
            sink: telemetry,
            requestId,
            method: request.method,
            pathname,
            transaction: "match",
            isPartial: false,
            matchStart,
          });
          emitter.start();

          const ctxBuildStart = INTERNAL_RANGO_DEBUG ? performance.now() : 0;
          const result = await createMatchContextForFull(request, env);
          if (INTERNAL_RANGO_DEBUG) {
            console.log(
              `[Server][match] context built +${Math.round(performance.now() - ctxBuildStart)}ms (abs ${Math.round(performance.now())})`,
            );
          }

          if ("type" in result && result.type === "redirect") {
            emitter.end(0, false);
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
            const pipeStart = INTERNAL_RANGO_DEBUG ? performance.now() : 0;
            const matchResult = await collectMatchResult(pipeline, ctx, state);
            if (INTERNAL_RANGO_DEBUG) {
              console.log(
                `[Server][match] pipeline collected +${Math.round(performance.now() - pipeStart)}ms (abs ${Math.round(performance.now())})`,
              );
            }
            if (hasTelemetry || cacheSignalEnabled) {
              const signalSegments = buildSignal(ctx.routeKey, state);
              recordSignalIfEnabled(signalSegments);
              emitter.cacheDecision(ctx.routeKey, state, signalSegments);
            }
            emitter.end(matchResult.segments.length, state.cacheHit);
            return matchResult;
          } catch (error) {
            if (error instanceof Response) {
              // A thrown Response (middleware short-circuit — redirect / auth
              // gate) is a COMPLETED request from the consumer's seat, not an
              // error: emit request.end (the same shape the non-thrown redirect
              // result above already emits), never request.error with a
              // synthetic "[object Response]" error. Rethrow so the caller
              // drives the redirect. Carry the Response's status so a sink can
              // tell a 3xx short-circuit from a 2xx completion.
              emitter.end(0, false, error.status);
              throw error;
            }
            emitter.error(
              error instanceof Error ? error : new Error(String(error)),
              "routing",
            );
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
    // See match() above: the PPR shell capture re-runs matchPartial() under a
    // _shellCaptureRun context and must stay invisible to the sink.
    const emitTelemetry =
      hasTelemetry && !_getRequestContext()?._shellCaptureRun;
    const partialRequestId = emitTelemetry ? getRequestId(request) : undefined;
    return runWithRouterLogContext(
      { request, transaction: "matchPartial" },
      () => {
        const routerCtx = buildRouterContext();
        if (!emitTelemetry) routerCtx.telemetry = undefined;
        routerCtx.requestId = partialRequestId;
        return runWithRouterContext(routerCtx, async () =>
          withRouterLogScope("matchPartial", async () => {
            const matchStart = performance.now();
            const pathname =
              _getRequestContext()?.url?.pathname ??
              new URL(request.url).pathname;
            const emitter = createLifecycleEmitter({
              enabled: emitTelemetry,
              sink: telemetry,
              requestId: partialRequestId,
              method: request.method,
              pathname,
              transaction: "matchPartial",
              isPartial: true,
              matchStart,
            });
            emitter.start();

            const ctx = await createMatchContextForPartial(
              request,
              context,
              actionContext,
            );
            if (!ctx) {
              emitter.end(0, false);
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
                emitter.cacheDecision(ctx.routeKey, state, signalSegments);
              }
              emitter.end(matchResult.segments.length, state.cacheHit);
              return matchResult;
            } catch (error) {
              flushRevalidationTrace();
              if (error instanceof Response) {
                // A thrown Response (middleware short-circuit — redirect / auth
                // gate) is a COMPLETED request, not an error: emit request.end
                // (parity with match()), never request.error. Rethrow so the
                // caller drives the redirect. Carry the Response's status so a
                // sink can tell a 3xx short-circuit from a 2xx completion.
                emitter.end(0, false, error.status);
                throw error;
              }
              emitter.error(
                error instanceof Error ? error : new Error(String(error)),
                actionContext ? "action" : "revalidation",
              );
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
