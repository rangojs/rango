/**
 * Request stages
 *
 * The stages a request runs through before and after rendering: classify,
 * guard, the global middleware passes, the response route, and the
 * response's finalization. The RSC handler (rsc/handler.ts createRSCHandler)
 * runs them all around its Flight executor. The dispatch testing primitive
 * (testing/dispatch.ts) runs the passes, the response route, the partial
 * redirect and the finalization, around its own matching (router.previewMatch)
 * and its throw on an RSC route. Sharing them keeps dispatch's responses
 * identical to production's; a hand-kept mirror drifted once (#1128).
 *
 * No import of @vitejs/plugin-rsc on this graph: dispatch loads it in a
 * plain Vitest project, where plugin-rsc's entries cannot load (they import
 * Vite virtuals). testing/__tests__/testing-module-graph.test.ts pins it.
 */

import { requestHeaders } from "../server/request-headers.js";
import { isRouteNotFoundError } from "../errors.js";
import { matchMiddleware, executeMiddleware } from "../router/middleware.js";
import type { MiddlewareEntry } from "../router/middleware-types.js";
import {
  _getRequestContext,
  getRequestContext,
  type RequestContext,
} from "../server/request-context.js";
import {
  REWRITE_HEADER,
  runRewritePasses,
  type RewritePassesOptions,
  type RewritePassesResult,
} from "./rewrite-passes.js";
import { rewriteTrail } from "../server/rewrite-trail.js";
import {
  createReloadResponse,
  finalizeResponse,
  interceptRedirectForPartial,
} from "./helpers.js";
import { guardOutgoingRedirect } from "./redirect-guard.js";
import {
  isWebSocketUpgradeResponse,
  appendVaryAccept,
  trySetHeader,
} from "../response-utils.js";
import {
  handleResponseRoute,
  type ResponseRouteMatch,
} from "./response-route-handler.js";
import type { ErrorPhase } from "../types.js";
import type { OnErrorCallback } from "../types/error-types.js";
import {
  invokeOnError,
  type InvokeOnErrorContext,
} from "../router/error-handling.js";
import { createReverseFunction } from "../router/handler-context.js";
import {
  checkRequestOrigin,
  ORIGIN_CHECK_PHASE_BY_MODE,
  type OriginCheckConfig,
} from "./origin-guard.js";
import { applyStreamIdleTimeout } from "./stream-idle.js";
import {
  withTimeout,
  isTimeoutEnabled,
  RouterTimeoutError,
  createDefaultTimeoutResponse,
  type OnTimeoutCallback,
  type RenderTimeoutContext,
  type ResolvedTimeouts,
  type TimeoutPhase,
} from "../router/timeout.js";
import {
  safeEmit,
  resolveSink,
  getRequestId,
  type TelemetrySink,
} from "../router/telemetry.js";
import {
  classifyRequest,
  type ClassifyRequestDeps,
  type RequestPlan,
  type ResponseRoutePlan,
} from "../router/request-classification.js";
import { INTERNAL_RANGO_DEBUG } from "../internal-debug.js";
import type { CacheErrorCategory } from "../cache/cache-error.js";

/**
 * The router members the stages read. The handler's `RangoInternal` carries
 * them; dispatch reads them off the router a test passes.
 */
export interface StageRouter<TEnv = unknown> {
  readonly basename: string | undefined;
  readonly middleware: MiddlewareEntry<TEnv>[];
  readonly onError?: OnErrorCallback<TEnv>;
  readonly telemetry?: TelemetrySink;
  readonly timeouts?: ResolvedTimeouts;
  readonly onTimeout?: OnTimeoutCallback<TEnv>;
}

/** Report an error through the router's onError. */
export type ReportError<TEnv = unknown> = (
  error: unknown,
  phase: ErrorPhase,
  context: InvokeOnErrorContext<TEnv>,
) => void;

/**
 * What the stages call back into. The handler's context bundle
 * (rsc/handler-context.ts HandlerContext) extends it.
 */
export interface RequestStageContext<TEnv = unknown> {
  router: StageRouter<TEnv>;
  callOnError: ReportError<TEnv>;
  getRequiredRouteMap: () => Record<string, string>;
  /**
   * The redirect a partial or action request receives: a Flight payload in
   * the handler (fetch() would follow a raw 3xx to HTML). dispatch has no
   * Flight runtime and answers 204 + X-RSC-Redirect.
   */
  createRedirectFlightResponse: (
    redirectUrl: string,
    locationState?: Record<string, unknown>,
    external?: boolean,
  ) => Response;
  /**
   * Reports a response-route handler's own throw; absent, it goes to
   * callOnError with phase "handler". dispatch passes a no-op: it does not
   * report that throw (its documented boundary, testing/dispatch.ts).
   */
  reportResponseRouteError?: (
    error: unknown,
    context: InvokeOnErrorContext<TEnv>,
  ) => void;
}

/** What classify and guardRequest read beyond the stage context. */
export interface ClassifyContext<TEnv = unknown> {
  router: {
    readonly id: string;
    readonly findMatch: ClassifyRequestDeps<TEnv>["findMatch"];
    readonly originCheck?: OriginCheckConfig<TEnv>;
  };
  /** The router's DOCUMENT version: the `_rsc_v` reload check. */
  version: string;
}

/**
 * Per-request error reporter that deduplicates via the ALS request context.
 *
 * Uses the same _reportedErrors WeakSet as the router layer so errors
 * that propagate across layers are only reported once per request.
 */
export function createErrorReporter<TEnv>(router: {
  readonly onError?: OnErrorCallback<TEnv>;
}): ReportError<TEnv> {
  return (error, phase, context) => {
    // Guard: abort signal handlers fire asynchronously outside the ALS
    // request scope, so the context may be gone. Skip dedup in that
    // case — the error is from a cancelled stream, not a real failure.
    const reqCtx = _getRequestContext();
    if (error != null && typeof error === "object" && reqCtx) {
      if (reqCtx._reportedErrors.has(error)) return;
      reqCtx._reportedErrors.add(error);
    }
    invokeOnError(router.onError, error, phase, context, "RSC");
  };
}

/**
 * Wire background error reporting so "use cache" and other subsystems can
 * surface non-fatal errors through the router's onError callback.
 */
export function reportBackgroundErrors<TEnv>(
  reqCtx: RequestContext<TEnv>,
  request: Request,
  url: URL,
  callOnError: ReportError<TEnv>,
): void {
  reqCtx._reportBackgroundError = (
    error: unknown,
    category: CacheErrorCategory,
  ) => {
    callOnError(error, "cache", {
      request,
      url,
      metadata: { category },
    });
  };
}

/**
 * Classify a request into its plan. classifyRequest throws
 * RouteNotFoundError for an unknown route; that falls through to a
 * full-render plan with no matched route, so the render path renders the
 * 404 page (match()/matchPartial() re-throw and the render's catch renders
 * it).
 */
export async function classify<TEnv>(
  request: Request,
  url: URL,
  ctx: ClassifyContext<TEnv>,
): Promise<RequestPlan<TEnv>> {
  try {
    return await classifyRequest<TEnv>(request, url, {
      findMatch: ctx.router.findMatch,
      routerVersion: ctx.version,
      routerId: ctx.router.id,
    });
  } catch (error) {
    if (!isRouteNotFoundError(error)) throw error;
    return {
      mode: "full-render",
      route: {
        matched: null as any,
        manifestEntry: null as any,
        entries: [],
        routeKey: "",
        localRouteName: "",
        params: {},
        routeMiddleware: [],
        cacheScope: null,
        isPassthrough: false,
      },
      negotiated: false,
    };
  }
}

/**
 * The checks between classification and execution. Returns the response of a
 * terminal plan (a partial request's redirect, a version or app-switch
 * reload) or of a rejected origin, null to run the plan. Throws for a
 * rewritten action whose target is not a page route.
 */
export async function guardRequest<TEnv>(
  plan: RequestPlan<TEnv>,
  request: Request,
  env: TEnv,
  url: URL,
  ctx: RequestStageContext<TEnv> & ClassifyContext<TEnv>,
): Promise<Response | null> {
  // A rewritten pass of an action must reach the branch that runs it: the
  // one that ran it re-renders from its outcome, and a JS action a global
  // rewrite moved before it ran runs only on the action branch. Any other
  // plan would serve the POST as a fresh request or drop the action; a
  // reload (version mismatch, app switch) does neither.
  const passCtx = getRequestContext();
  const actionRan = passCtx._actionRan;
  const actionMode = actionRan
    ? actionRan.kind === "action"
      ? "action"
      : "pe-render"
    : url.searchParams.has("_rsc_action") && rewriteTrail(passCtx)
      ? "action"
      : undefined;
  if (
    actionMode &&
    plan.mode !== actionMode &&
    plan.mode !== "version-mismatch" &&
    plan.mode !== "app-switch"
  ) {
    throw new Error(
      `A rewrite of a server action or form post must target a page ` +
        `route; ${url.pathname} ${plan.mode === "response" ? "is a response route" : plan.mode === "redirect" ? "redirects" : "is not one"}.`,
    );
  }

  // ---- Terminal plans (no execution needed) ----
  if (plan.mode === "redirect") {
    const redirected = partialRedirectResponse(plan.redirectUrl, url, ctx);
    if (redirected) return redirected;
  }

  // A reload points at the visitor's URL, never a rewrite target's.
  if (plan.mode === "version-mismatch") {
    console.log(
      `[RSC] Version mismatch: client=${url.searchParams.get("_rsc_v")}, server=${ctx.version}. Forcing reload.`,
    );
    return createReloadResponse(getRequestContext(), plan.reloadUrl);
  }

  if (plan.mode === "app-switch") {
    // Cross-app SPA navigation crossed a host-router app boundary. Force a
    // real document navigation so the target app's document is re-established
    // (stylesheets, theme, warmup, prefetch-TTL). See request-classification.
    return createReloadResponse(getRequestContext(), plan.reloadUrl);
  }

  // ---- Origin guard (gate for action/loader/PE modes) ----
  const originPhase = ORIGIN_CHECK_PHASE_BY_MODE[plan.mode];
  if (originPhase) {
    const router = ctx.router;
    const originResult = await checkRequestOrigin(
      request,
      url,
      router.originCheck,
      env,
      router.id,
      originPhase,
    );
    if (originResult) {
      const origin = requestHeaders(request).get("origin");
      const host = requestHeaders(request).get("host");
      const originError = new Error(
        `Origin check rejected: ${origin ?? "none"} vs ${host ?? "none"}`,
      );
      originError.name = "OriginCheckError";

      ctx.callOnError(originError, "origin", {
        request,
        url,
        env,
        handledByBoundary: false,
        metadata: { phase: originPhase, origin, host },
      });

      if (router.telemetry) {
        safeEmit(resolveSink(router.telemetry), {
          type: "request.origin-rejected",
          timestamp: performance.now(),
          requestId: getRequestId(request),
          method: request.method,
          pathname: url.pathname,
          phase: originPhase,
          origin,
          host,
        });
      }

      return originResult;
    }
  }

  return null;
}

/**
 * A findMatch() redirect (trailing slash) on a partial request: redirects are
 * handled by the pipeline (match/matchPartial), but a partial request
 * short-circuits with a Flight redirect, since fetch() would follow a raw
 * 3xx. Null on a full request, which the render path redirects (match()
 * returns { redirect: url }).
 */
export function partialRedirectResponse<TEnv>(
  redirectUrl: string,
  url: URL,
  ctx: RequestStageContext<TEnv>,
): Response | null {
  return url.searchParams.has("_rsc_partial")
    ? ctx.createRedirectFlightResponse(redirectUrl)
    : null;
}

export interface RequestPassesOptions<TEnv> {
  ctx: RequestStageContext<TEnv>;
  reqCtx: RequestContext<TEnv>;
  /** The visitor's request and raw URL: the first pass. */
  request: Request;
  url: URL;
  env: TEnv;
  variables: Record<string, any>;
  /** The visitor's global middleware, when the caller matched it already. */
  firstPassMiddleware?: Array<{
    entry: MiddlewareEntry<TEnv>;
    params: Record<string, string>;
  }>;
  /** Runs before a pass's global chain; dispatch matches the pass there. */
  beforePass?: (request: Request, url: URL, index: number) => Promise<void>;
  /** The core handler a pass's global chain wraps. */
  core: (request: Request, url: URL) => Promise<Response>;
  onHop?: RewritePassesOptions["onHop"];
  refuse?: RewritePassesOptions["refuse"];
}

export interface RequestPassesResult extends RewritePassesResult {
  /** Whether the last pass ran a global middleware chain. */
  hasMiddleware: boolean;
}

/**
 * One pass per URL: the global middleware chain matched on the pass's path,
 * wrapping the core handler. A `throw rewrite()` from global or route
 * middleware unwinds the pass, and the next one runs the same request as
 * the target from the top, as a direct visit would (rsc/rewrite-passes.ts).
 */
export async function runRequestPasses<TEnv>(
  opts: RequestPassesOptions<TEnv>,
): Promise<RequestPassesResult> {
  const { ctx, env, variables } = opts;
  let passIndex = 0;
  let hasMiddleware = false;
  const runChain = (
    passRequest: Request,
    passUrl: URL,
    index: number,
  ): Promise<Response> => {
    const passMiddleware =
      index === 0 && opts.firstPassMiddleware
        ? opts.firstPassMiddleware
        : matchMiddleware(passUrl.pathname, ctx.router.middleware);
    hasMiddleware = passMiddleware.length > 0;
    const coreHandler = (): Promise<Response> =>
      opts.core(passRequest, passUrl);
    return hasMiddleware
      ? executeMiddleware(
          passMiddleware,
          passRequest,
          env,
          variables,
          coreHandler,
          createReverseFunction(ctx.getRequiredRouteMap()),
        )
      : coreHandler();
  };
  const { response, rewrittenTo } = await runRewritePasses({
    reqCtx: opts.reqCtx,
    request: opts.request,
    url: opts.url,
    routeMap: ctx.getRequiredRouteMap,
    basename: ctx.router.basename,
    runPass: (passRequest, passUrl) => {
      const index = passIndex++;
      return opts.beforePass
        ? opts
            .beforePass(passRequest, passUrl, index)
            .then(() => runChain(passRequest, passUrl, index))
        : runChain(passRequest, passUrl, index);
    },
    onHop: opts.onHop,
    report: (error, at) => {
      ctx.callOnError(error, "routing", {
        request: at.request,
        url: at.url,
        env,
        handledByBoundary: false,
      });
    },
    refuse: opts.refuse,
  });
  return { response, rewrittenTo, hasMiddleware };
}

/**
 * The flat match handleResponseRoute takes, with params at the top level,
 * built from a response-route plan.
 */
export function responseRouteMatch(
  plan: ResponseRoutePlan<any>,
): ResponseRouteMatch {
  return {
    responseType: plan.responseType,
    handler: plan.handler,
    params: plan.route.params,
    negotiated: plan.negotiated,
    manifestEntry: plan.manifestEntry,
    routeMiddleware: plan.routeMiddleware,
  };
}

export interface ServeResponseRouteOptions<TEnv> {
  match: ResponseRouteMatch;
  /** The matched route's key, for the timeout report. */
  routeKey: string | undefined;
  /** The pass's request, raw URL and env. */
  request: Request;
  url: URL;
  env: TEnv;
  variables: Record<string, any>;
  /**
   * Receives the handler's work when the deadline wins. The handler leaves
   * it running; dispatch cancels its body.
   */
  abandon?: (work: Promise<Response>) => void;
}

/**
 * A response route: its handler (rsc/response-route-handler.ts) under the
 * renderStartMs deadline, which starts here, inside the global chain, so
 * global middleware time never counts toward it.
 */
export async function serveResponseRoute<TEnv>(
  ctx: RequestStageContext<TEnv>,
  opts: ServeResponseRouteOptions<TEnv>,
): Promise<Response> {
  const { match, request, env, url } = opts;
  const work = handleResponseRoute(
    ctx,
    match,
    request,
    env,
    url,
    opts.variables,
  );
  const responseOutcome = await withTimeout(
    work,
    ctx.router.timeouts?.renderStartMs,
    "render-start",
  );
  if (responseOutcome.timedOut) {
    opts.abandon?.(work);
    return timeoutResponse(
      ctx,
      request,
      env,
      url,
      "render-start",
      responseOutcome.durationMs,
      opts.routeKey,
    );
  }
  const response = responseOutcome.result;
  if (match.negotiated && !isWebSocketUpgradeResponse(response)) {
    // handleResponseRoute (callHandlerWithVary) already appends Vary: Accept
    // for negotiated responses; dedup so we don't emit Vary: Accept, Accept.
    appendVaryAccept(response);
  }
  return response;
}

/**
 * Handle a timeout by reporting the error, emitting telemetry,
 * and returning either the custom onTimeout response or a default 504.
 */
export async function timeoutResponse<TEnv>(
  ctx: RequestStageContext<TEnv>,
  request: Request,
  env: TEnv,
  url: URL,
  phase: TimeoutPhase,
  durationMs: number,
  routeKey?: string,
  actionId?: string,
): Promise<Response> {
  const router = ctx.router;
  const timeoutError = new RouterTimeoutError(phase, durationMs);
  const requestContext = _getRequestContext<TEnv>();
  const cursor = requestContext?._renderForeground;
  const render: RenderTimeoutContext | undefined =
    phase === "render-start" && cursor
      ? {
          mode: cursor.mode,
          phase: cursor.phase,
          state: cursor.state,
          completed: cursor.completed,
          total: cursor.total,
          ...(cursor.phaseStartedAt !== undefined && {
            phaseDurationMs: performance.now() - cursor.phaseStartedAt,
          }),
        }
      : undefined;
  const trace =
    phase === "render-start" ? requestContext?._activeRoutine : undefined;
  const activeEntries = trace?.active() ?? [];
  const activeStep = activeEntries.at(-1);
  const activeAt = performance.now();
  const routineSnapshot =
    trace && activeStep
      ? {
          name: trace.name,
          path: activeEntries.map((entry) => entry.name),
          durationMs: activeAt - activeStep.startedAt,
        }
      : undefined;

  if (INTERNAL_RANGO_DEBUG && trace && activeStep) {
    console.log(
      `[routine] TIMEOUT ${request.method} ${url.pathname} (${trace.name})\n${trace.formatActive(activeEntries, activeAt)}`,
    );
  }

  // Each surface gets its OWN shallow render snapshot. A consumer that mutates
  // its copy must not corrupt what the other two observe. The internal-debug
  // routine snapshot is bounded metadata sent only to onError.
  ctx.callOnError(timeoutError, phase === "action" ? "action" : "handler", {
    request,
    url,
    env,
    routeKey,
    actionId,
    handledByBoundary: false,
    metadata: {
      timeout: true,
      phase,
      durationMs,
      ...(render && { render: { ...render } }),
      ...(routineSnapshot && { routine: routineSnapshot }),
    },
  });

  if (router.telemetry) {
    safeEmit(resolveSink(router.telemetry), {
      type: "request.timeout",
      timestamp: performance.now(),
      requestId: getRequestId(request),
      phase,
      pathname: url.pathname,
      routeKey,
      actionId,
      durationMs,
      customHandler: !!router.onTimeout,
      ...(render && { render: { ...render } }),
    });
  }

  if (router.onTimeout) {
    try {
      return await router.onTimeout({
        phase,
        request,
        url,
        env,
        routeKey,
        actionId,
        durationMs,
        ...(render && { render: { ...render } }),
      });
    } catch (e) {
      if (process.env.NODE_ENV !== "production") {
        console.error("[RSC] onTimeout callback error:", e);
      }
      return createDefaultTimeoutResponse(phase);
    }
  }

  return createDefaultTimeoutResponse(phase);
}

export interface FinalizeRequestOptions<TEnv> {
  ctx: RequestStageContext<TEnv>;
  reqCtx: RequestContext<TEnv>;
  /** The visitor's request, raw URL and env. */
  request: Request;
  url: URL;
  env: TEnv;
  /** runRequestPasses' result. */
  hasMiddleware: boolean;
  rewrittenTo?: string;
  /** Runs on the response before the open-redirect guard. */
  beforeGuard?: (response: Response) => void;
}

/**
 * The response the global chain returned, made ready to leave: a partial or
 * action request's redirect converted, onResponse callbacks drained, the
 * rewrite header, the open-redirect guard and the stream-idle watchdog.
 */
export function finalizeRequestResponse<TEnv>(
  downstream: Response,
  opts: FinalizeRequestOptions<TEnv>,
): Response {
  const { ctx, reqCtx, request, url, env } = opts;
  const router = ctx.router;
  let response: Response;
  if (opts.hasMiddleware) {
    if (
      url.searchParams.has("_rsc_partial") ||
      url.searchParams.has("_rsc_action")
    ) {
      const intercepted = interceptRedirectForPartial(
        downstream,
        ctx.createRedirectFlightResponse,
        { requestOrigin: url.origin, basename: router.basename },
      );
      response = intercepted ?? finalizeResponse(downstream);
    } else {
      response = finalizeResponse(downstream);
    }
  } else {
    response = downstream;
  }

  if (opts.rewrittenTo !== undefined) {
    trySetHeader(response, REWRITE_HEADER, opts.rewrittenTo);
  }
  opts.beforeGuard?.(response);

  // Single open-redirect chokepoint: every response (PE, full-page,
  // middleware short-circuit, response-route) funnels through here, so
  // guarding browser-followed (3xx) redirects once covers them all and any
  // future redirect exit. Soft SPA/Flight redirects are 200/204 and pass
  // through untouched (validated client-side instead).
  const guarded = guardOutgoingRedirect(response, url.origin, router.basename);

  // Stream-idle watchdog (opt-in via timeouts.streamIdleMs): bounds
  // end-to-end idle flow on the streamed body — see rsc/stream-idle.ts
  // for the semantics. Applied at this finalization chokepoint so every
  // streaming exit is covered; websocket upgrades must never be
  // reconstructed and bodiless responses have nothing to bound. The
  // trip fires POST-handoff (the request ALS may be gone), so it
  // reports via the eagerly captured surfaces — callOnError +
  // router.telemetry directly — mirroring handleStore.onError.
  // onTimeout does NOT apply: the response already left the handler,
  // so no replacement Response can be served mid-stream.
  const streamIdleMs = router.timeouts?.streamIdleMs;
  // Websocket check FIRST: a workerd upgrade response must never have
  // its body getter poked.
  if (
    !isTimeoutEnabled(streamIdleMs) ||
    isWebSocketUpgradeResponse(guarded) ||
    !guarded.body
  ) {
    return guarded;
  }
  const routeKey = reqCtx._routeName;
  return applyStreamIdleTimeout(guarded, streamIdleMs!, (tripInfo) => {
    ctx.callOnError(tripInfo.error, "handler", {
      request,
      url,
      env,
      routeKey,
      handledByBoundary: false,
      metadata: {
        timeout: true,
        phase: "stream-idle",
        durationMs: tripInfo.totalMs,
      },
    });
    if (router.telemetry) {
      safeEmit(resolveSink(router.telemetry), {
        type: "request.timeout",
        timestamp: performance.now(),
        requestId: getRequestId(request),
        phase: "stream-idle",
        pathname: url.pathname,
        routeKey,
        durationMs: tripInfo.totalMs,
        customHandler: false,
      });
    }
  });
}
