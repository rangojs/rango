/**
 * Progressive Enhancement Handler
 *
 * Handles no-JS form submissions. When JavaScript is disabled, React renders
 * forms with hidden fields ($ACTION_REF_*, $ACTION_KEY) containing the action
 * reference. We detect these and return HTML instead of RSC stream.
 */

import {
  getRequestContext,
  setRequestContextParams,
} from "../server/request-context.js";
import { createSsrHtmlStage } from "./ssr-setup.js";
import type { MiddlewareFn } from "../router/middleware.js";
import { executeMiddleware } from "../router/middleware.js";
import { observePhase, PHASES } from "../router/instrument.js";
import { gateTransitions } from "./transition-gate.js";
import { resolvedHandleStream } from "../handles/deferred-resolution.js";
import type { RscPayload, ReactFormState } from "./types.js";
import {
  createResponseWithMergedHeaders,
  finalizeResponse,
  buildRouteMiddlewareEntries,
} from "./helpers.js";
import {
  createRenderStageTraceBridge,
  renderRscResponse,
} from "./render-pipeline.js";
import {
  createRoutineTrace,
  runRoutine,
  step,
  type RoutinePlan,
  type RoutineTrace,
} from "./routine-plan.js";
import type { HandlerContext } from "./handler-context.js";
import {
  extractRedirectResponse,
  warnNonRedirectPeResponse,
} from "./runtime-warnings.js";
import { INTERNAL_RANGO_DEBUG } from "../internal-debug.js";

export interface PeRouteMiddlewareInfo {
  routeMiddleware?: Array<{
    handler: MiddlewareFn;
    params: Record<string, string>;
  }>;
  variables: Record<string, any>;
  routeReverse?: (
    name: string,
    params?: Record<string, string>,
    search?: Record<string, unknown>,
  ) => string;
}

export async function handleProgressiveEnhancement<TEnv>(
  ctx: HandlerContext<TEnv>,
  request: Request,
  env: TEnv,
  url: URL,
  isAction: boolean,
  handleStore: ReturnType<typeof getRequestContext>["_handleStore"],
  nonce: string | undefined,
  routeMwInfo?: PeRouteMiddlewareInfo,
): Promise<Response | null> {
  const contentType = request.headers.get("content-type") || "";
  const isFormSubmission =
    contentType.includes("multipart/form-data") ||
    contentType.includes("application/x-www-form-urlencoded");

  if (request.method !== "POST" || isAction || !isFormSubmission) {
    return null;
  }

  // Flow trace: shared by every plan this request drives (error-boundary
  // renders and the re-render), so a PE request prints ONE tree. A non-PE form
  // POST (no $ACTION fields) drives no plan and stays silent.
  const trace = INTERNAL_RANGO_DEBUG ? createRoutineTrace("pe") : undefined;
  try {
    return await handleProgressiveEnhancementInner(
      ctx,
      request,
      env,
      url,
      handleStore,
      nonce,
      routeMwInfo,
      trace,
    );
  } finally {
    if (trace && trace.entries.length > 0) {
      console.log(
        `[routine] ${request.method} ${url.pathname} (${trace.name})\n${trace.format()}`,
      );
    }
  }
}

async function handleProgressiveEnhancementInner<TEnv>(
  ctx: HandlerContext<TEnv>,
  request: Request,
  env: TEnv,
  url: URL,
  handleStore: ReturnType<typeof getRequestContext>["_handleStore"],
  nonce: string | undefined,
  routeMwInfo: PeRouteMiddlewareInfo | undefined,
  trace: RoutineTrace | undefined,
): Promise<Response | null> {
  // Clone the request to read FormData without consuming it.
  // Wrap in try-catch so malformed POST bodies are reported as action
  // errors, not routing errors from the outer catch in handler.ts.
  let formData: FormData;
  try {
    formData = await request.clone().formData();
  } catch (error) {
    // Attempt error boundary rendering so the user sees a meaningful page.
    const errorHtml = await renderPeErrorBoundary(
      ctx,
      request,
      env,
      url,
      error,
      handleStore,
      nonce,
      trace,
    );
    if (errorHtml) {
      ctx.callOnError(error, "action", {
        request,
        url,
        env,
        handledByBoundary: true,
      });
      return errorHtml;
    }

    ctx.callOnError(error, "action", {
      request,
      url,
      env,
      handledByBoundary: false,
    });
    console.error("[RSC] Progressive enhancement form parse error:", error);
    return createResponseWithMergedHeaders(null, { status: 400 });
  }

  // Look for React's progressive enhancement hidden fields
  let isDirectAction = false;
  let isUseActionState = false;
  let directActionId: string | null = null;

  formData.forEach((_value, key) => {
    if (key.startsWith("$ACTION_ID_")) {
      isDirectAction = true;
      directActionId = key.slice("$ACTION_ID_".length);
    } else if (key.startsWith("$ACTION_REF_")) {
      isUseActionState = true;
    }
  });

  if (!isDirectAction && !isUseActionState) {
    return null;
  }

  // Execute action and return HTML
  let actionResult: unknown = undefined;
  let reactFormState: ReactFormState | null = null;
  // Status for the fall-through re-render after a boundaryless action error.
  // When an action throws and NO error boundary matches, the PE path re-renders
  // the page (below) the same way it would after a successful action. Without
  // this the re-render serves HTTP 200, diverging from the JS path which serves
  // 500 (server-action.ts sets actionStatus=500 for the same boundaryless error).
  // 500 is carried only into the final HTML response, never the redirect branch.
  let boundarylessErrorStatus: number | undefined;

  if (isUseActionState) {
    // Decode and extract action identity before execution so error
    // handlers can report actionId even when the action throws.
    let useActionStateId: string | undefined;
    try {
      const boundAction = await ctx.decodeAction(formData);
      // React's custom .bind() preserves $$id on server references.
      useActionStateId = (boundAction as { $$id?: string }).$$id ?? undefined;
      // Meter the no-JS form action as the action phase, same as the JS path.
      actionResult = await observePhase(
        PHASES.action(useActionStateId ?? "useActionState"),
        () => boundAction(),
      );
    } catch (error) {
      // Handle thrown redirect (e.g., throw redirect('/path'))
      const redirectResponse = extractRedirectResponse(error);
      if (redirectResponse) return redirectResponse;

      // Attempt error boundary rendering for the PE path
      const errorHtml = await renderPeErrorBoundary(
        ctx,
        request,
        env,
        url,
        error,
        handleStore,
        nonce,
        trace,
        useActionStateId,
        true, // an action ran and threw
      );
      if (errorHtml) return errorHtml;

      ctx.callOnError(error, "action", {
        request,
        url,
        env,
        actionId: useActionStateId,
        handledByBoundary: false,
      });
      console.error("[RSC] Progressive enhancement action error:", error);
      // No boundary matched — the fall-through re-render must carry 500 to match
      // the JS path's boundaryless-error status (server-action.ts).
      boundarylessErrorStatus = 500;
    }
  } else if (isDirectAction && directActionId) {
    const temporaryReferences = ctx.createTemporaryReferenceSet();

    // INTENTIONAL JS/PE divergence (do NOT "fix" to match the JS reject path).
    // On the JS path React Flight-encodes the action args, so decodeReply
    // succeeds or a failure means a malformed body (rejected). On the no-JS PE
    // path the browser submits a raw <form action={fn}> POST with NO encoded
    // args, so decodeReply throws by design and the raw FormData IS the action
    // argument (the React form-action convention: fn(formData)). Removing this
    // fallback breaks every unbound no-JS form action (verified: it fails the
    // progressive-enhancement dev+prod e2e suite). See #572 (decided: keep).
    let args: unknown[] = [];
    try {
      args = await ctx.decodeReply(formData, { temporaryReferences });
    } catch {
      args = [formData];
    }

    try {
      const loadedAction = await ctx.loadServerAction(directActionId);
      actionResult = await observePhase(PHASES.action(directActionId), () =>
        loadedAction.apply(null, args),
      );
    } catch (error) {
      // Handle thrown redirect (e.g., throw redirect('/path'))
      const redirectResponse = extractRedirectResponse(error);
      if (redirectResponse) return redirectResponse;

      // Attempt error boundary rendering for the PE path
      const errorHtml = await renderPeErrorBoundary(
        ctx,
        request,
        env,
        url,
        error,
        handleStore,
        nonce,
        trace,
        directActionId,
        true, // an action ran and threw
      );
      if (errorHtml) return errorHtml;

      ctx.callOnError(error, "action", {
        request,
        url,
        env,
        actionId: directActionId,
        handledByBoundary: false,
      });
      console.error("[RSC] Progressive enhancement action error:", error);
      // No boundary matched — the fall-through re-render must carry 500 to match
      // the JS path's boundaryless-error status (server-action.ts).
      boundarylessErrorStatus = 500;
    }
  }

  // Handle Response returned from action during PE.
  // In the JS path, executeServerAction intercepts redirect Responses and
  // short-circuits. The PE path must handle them too.
  if (actionResult instanceof Response) {
    const redirectResponse = extractRedirectResponse(actionResult);
    if (redirectResponse) return redirectResponse;
    // W3: Non-redirect Response — discard it so it doesn't flow into
    // decodeFormState or the re-render payload.
    if (process.env.NODE_ENV !== "production") {
      warnNonRedirectPeResponse();
    }
    actionResult = undefined;
  }

  // Decode form state for useActionState progressive enhancement
  try {
    reactFormState = await ctx.decodeFormState(actionResult, formData);
  } catch (error) {
    ctx.callOnError(error, "action", {
      request,
      url,
      env,
      handledByBoundary: false,
    });
    console.error("[RSC] Failed to decode form state:", error);
  }

  // Re-render the page and return HTML.
  // Route middleware wraps the render so context variables, headers, and
  // cookies set by route middleware are available during re-render — matching
  // the behavior of JS-enabled requests.
  const renderPage = async (): Promise<Response> => {
    // Preserve the original POST request's headers (Authorization, Cookie,
    // custom headers) so loaders that read request headers/cookies behave
    // identically under PE and the JS action path. Drop body-framing headers
    // from the bodyless GET and force the HTML accept.
    const headers = new Headers(request.headers);
    headers.delete("content-type");
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("transfer-encoding");
    headers.set("accept", "text/html");
    const renderRequest = new Request(url.toString(), {
      method: "GET",
      headers,
    });

    // JS/PE parity: this is an action's revalidation render, so mark it BEFORE
    // matching — a stale `foregroundOnAction` cache entry must re-execute in the
    // foreground during the re-render, exactly as the JS path's
    // revalidateAfterAction does. PPR transition({ when }) runs during match,
    // while foregroundOnAction reads _inActionRevalidation there too, so all
    // action metadata must be available before matching.
    const peReqCtx = getRequestContext();
    peReqCtx._inActionRevalidation = true;
    peReqCtx._gateActionId = directActionId ?? undefined;
    peReqCtx._gateActionUrl = new URL(url);
    peReqCtx._gateActionResult = actionResult;
    peReqCtx._gateFormData = formData;

    return runRoutine(
      peRenderPlan({
        ctx,
        request,
        env,
        url,
        renderRequest,
        handleStore,
        nonce,
        reactFormState,
        boundarylessErrorStatus,
        directActionId,
      }),
      { trace, owner: getRequestContext() },
    );
  };

  // Execute route middleware wrapping the render, if any.
  // finalizeResponse drains onResponse callbacks that middleware short-circuits
  // may leave behind (executeMiddleware does not finalize them itself).
  if (routeMwInfo?.routeMiddleware && routeMwInfo.routeMiddleware.length > 0) {
    return finalizeResponse(
      await executeMiddleware(
        buildRouteMiddlewareEntries(routeMwInfo.routeMiddleware),
        request,
        env,
        routeMwInfo.variables,
        renderPage,
        routeMwInfo.routeReverse,
      ),
    );
  }

  return renderPage();
}

interface PeRenderInput<TEnv> {
  ctx: HandlerContext<TEnv>;
  request: Request;
  env: TEnv;
  url: URL;
  renderRequest: Request;
  handleStore: ReturnType<typeof getRequestContext>["_handleStore"];
  nonce: string | undefined;
  reactFormState: ReactFormState | null;
  boundarylessErrorStatus: number | undefined;
  directActionId: string | null;
}

/** PE re-render: match the bodyless GET mirror, then render full HTML. */
function* peRenderPlan<TEnv>(
  input: PeRenderInput<TEnv>,
): RoutinePlan<Response> {
  const { ctx, env, renderRequest } = input;

  const match = yield* step("match", () =>
    ctx.router.match(renderRequest, { env }),
  );

  if (match.redirect) {
    return createResponseWithMergedHeaders(null, {
      status: 308,
      headers: { Location: match.redirect },
    });
  }

  return yield* step("render", () => renderPeResponse(input, match));
}

/** Build the PE full-document payload and render it through the stage driver. */
function renderPeResponse<TEnv>(
  input: PeRenderInput<TEnv>,
  match: Awaited<ReturnType<HandlerContext<TEnv>["router"]["match"]>>,
): Promise<Response> {
  const {
    ctx,
    request,
    env,
    url,
    handleStore,
    nonce,
    reactFormState,
    boundarylessErrorStatus,
    directActionId,
  } = input;

  const payload: RscPayload = {
    metadata: {
      pathname: url.pathname,
      routerId: ctx.router.id,
      basename: ctx.router.basename,
      segments: gateTransitions(
        match.segments,
        getRequestContext(),
        ctx.router.onError,
      ),
      matched: match.matched,
      diff: match.diff,
      resolvedIds: match.resolvedIds,
      params: match.params,
      isPartial: false,
      rootLayout: ctx.router.rootLayout,
      // PE full render: resolve deferred handle values server-side.
      handles: resolvedHandleStream(handleStore),
      version: ctx.version,
      stateCookieName: ctx.router.resolvedStateCookieName,
      themeConfig: ctx.router.themeConfig,
      warmupEnabled: ctx.router.warmupEnabled,
      strictMode: ctx.router.strictMode,
      initialTheme: getRequestContext().theme,
    },
  };

  const trace = getRequestContext()._activeRoutine;

  const stageTracking = {
    mode: "progressive-enhancement" as const,
    routeKey: getRequestContext()._routeName,
    actionId: directActionId ?? undefined,
    onEvent: trace && createRenderStageTraceBridge(trace),
  };
  return renderRscResponse(
    {
      ctx,
      request,
      env,
      url,
      payload,
      init: {
        // boundarylessErrorStatus is set only when the action threw and no error
        // boundary matched; it makes the re-render carry 500 like the JS path.
        // The redirect branch in peRenderPlan returns before this, so a redirect
        // re-render keeps its 308 and is never overridden.
        ...(boundarylessErrorStatus !== undefined
          ? { status: boundarylessErrorStatus }
          : {}),
        headers: { "content-type": "text/html;charset=utf-8" },
      },
      tracking: stageTracking,
    },
    {
      // metricsStore=undefined is safe: the handler already stashed the early
      // SSR setup promise, so this reuses it instead of starting setup again.
      // reactFormState travels through the SSR option, not RscPayload.
      html: createSsrHtmlStage({
        ctx,
        request,
        env,
        url,
        metricsStore: undefined,
        render: { formState: reactFormState, nonce },
      }),
    },
  );
}

interface PeErrorBoundaryInput<TEnv> {
  ctx: HandlerContext<TEnv>;
  request: Request;
  env: TEnv;
  url: URL;
  error: unknown;
  handleStore: ReturnType<typeof getRequestContext>["_handleStore"];
  nonce: string | undefined;
  actionId: string | null | undefined;
  actionRan: boolean;
}

type PeErrorMatch<TEnv> = NonNullable<
  Awaited<ReturnType<HandlerContext<TEnv>["router"]["matchError"]>>
>;

/**
 * Attempt to render an error boundary as full HTML for the PE path.
 * Returns null if no error boundary is found (caller falls through to
 * normal page re-render).
 */
async function renderPeErrorBoundary<TEnv>(
  ctx: HandlerContext<TEnv>,
  request: Request,
  env: TEnv,
  url: URL,
  error: unknown,
  handleStore: ReturnType<typeof getRequestContext>["_handleStore"],
  nonce: string | undefined,
  trace: RoutineTrace | undefined,
  actionId?: string | null,
  // True when an action actually ran and threw (vs a malformed form body, where
  // no action executed). Drives _inActionRevalidation for JS/PE parity — it must
  // NOT be inferred from actionId, since a useActionState bound action can run
  // and throw with no $$id (actionId === undefined) yet still be an action error.
  actionRan = false,
): Promise<Response | null> {
  return runRoutine(
    peErrorBoundaryPlan({
      ctx,
      request,
      env,
      url,
      error,
      handleStore,
      nonce,
      actionId,
      actionRan,
    }),
    { trace, owner: getRequestContext() },
  );
}

/** PE error boundary: match a boundary for the thrown error, then render it. */
function* peErrorBoundaryPlan<TEnv>(
  input: PeErrorBoundaryInput<TEnv>,
): RoutinePlan<Response | null> {
  const boundary = yield* step("match:error", () =>
    matchPeErrorBoundary(input),
  );
  if (!boundary) return null;
  return yield* step("render", () => renderPeErrorResponse(input, boundary));
}

/**
 * Match an error boundary for the PE path, owning the reporting protocol:
 * a matchError failure reports the ORIGINAL error as unhandled and rethrows
 * the match failure; a miss returns null; a hit reports handled and stamps
 * params + action gate context before the render.
 */
async function matchPeErrorBoundary<TEnv>(
  input: PeErrorBoundaryInput<TEnv>,
): Promise<PeErrorMatch<TEnv> | null> {
  const { ctx, request, env, url, error, actionId, actionRan } = input;

  // JS/PE parity for an action-triggered error re-render: a stale
  // `foregroundOnAction` cache entry inside the error boundary must foreground
  // too, exactly as the JS path (revalidateAfterAction sets this unconditionally
  // before rendering the error boundary). Set BEFORE matchError (the cached fn
  // runs during it). Gated on actionRan, NOT actionId — a malformed form body
  // (actionRan=false) ran no action and must keep SWR.
  if (actionRan) {
    getRequestContext()._inActionRevalidation = true;
  }

  let errorResult;
  try {
    errorResult = await ctx.router.matchError(request, { env }, error, "route");
  } catch (matchErr) {
    ctx.callOnError(error, "action", {
      request,
      url,
      env,
      actionId: actionId ?? undefined,
      handledByBoundary: false,
    });
    throw matchErr;
  }

  if (!errorResult) return null;

  ctx.callOnError(error, "action", {
    request,
    url,
    env,
    actionId: actionId ?? undefined,
    handledByBoundary: true,
  });

  setRequestContextParams(errorResult.params, errorResult.routeName);

  // Only the failing action id + URL are in scope here (no formData/actionResult
  // thread into this helper). Expose the URL only when the action id is known:
  // this helper also handles malformed form bodies before action detection, and
  // those should not look like action-triggered renders to transition({ when }).
  if (actionId != null) {
    const peErrCtx = getRequestContext();
    peErrCtx._gateActionId = actionId;
    peErrCtx._gateActionUrl = new URL(url);
  }

  return errorResult;
}

/** Render the matched PE error boundary as a full HTML document. */
function renderPeErrorResponse<TEnv>(
  input: PeErrorBoundaryInput<TEnv>,
  errorResult: PeErrorMatch<TEnv>,
): Promise<Response> {
  const { ctx, request, env, url, handleStore, nonce, actionId } = input;

  const payload: RscPayload = {
    metadata: {
      pathname: url.pathname,
      routerId: ctx.router.id,
      basename: ctx.router.basename,
      segments: gateTransitions(
        errorResult.segments,
        getRequestContext(),
        ctx.router.onError,
      ),
      matched: errorResult.matched,
      diff: errorResult.diff,
      resolvedIds: errorResult.resolvedIds,
      params: errorResult.params,
      isPartial: false,
      isError: true,
      rootLayout: ctx.router.rootLayout,
      // PE error-boundary full render: resolve deferred handle values server-side.
      handles: resolvedHandleStream(handleStore),
      version: ctx.version,
      stateCookieName: ctx.router.resolvedStateCookieName,
      themeConfig: ctx.router.themeConfig,
      warmupEnabled: ctx.router.warmupEnabled,
      strictMode: ctx.router.strictMode,
      initialTheme: getRequestContext().theme,
    },
  };

  const trace = getRequestContext()._activeRoutine;

  const stageTracking = {
    mode: "progressive-enhancement-error" as const,
    routeKey: getRequestContext()._routeName,
    actionId: actionId ?? undefined,
    onEvent: trace && createRenderStageTraceBridge(trace),
  };
  return renderRscResponse(
    {
      ctx,
      request,
      env,
      url,
      payload,
      init: {
        status: 500,
        headers: { "content-type": "text/html;charset=utf-8" },
      },
      tracking: stageTracking,
    },
    {
      // Reuse the early setup promise; the driver times only renderHTML.
      html: createSsrHtmlStage({
        ctx,
        request,
        env,
        url,
        metricsStore: undefined,
        render: { nonce },
      }),
    },
  );
}
