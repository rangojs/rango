/**
 * Server Action Handler
 *
 * Handles server action execution and post-action revalidation as two
 * separate phases:
 *
 * 1. executeServerAction — decodes args, runs the action, handles redirects
 *    and error boundaries. Returns either a final Response (redirect/error)
 *    or an ActionContinuation for the revalidation phase.
 *
 * 2. revalidateAfterAction — takes the continuation, matches affected
 *    segments, builds the RSC payload, and returns the Flight response.
 *
 * The handler (handler.ts) runs the action BEFORE route middleware, then
 * wraps revalidation inside route middleware — identical to a normal render.
 */

import {
  requireRequestContext,
  setRequestContextParams,
} from "../server/request-context.js";
import { appendMetric } from "../router/metrics.js";
import type { RscPayload } from "./types.js";
import {
  hasBodyContent,
  createResponseWithMergedHeaders,
  createSimpleRedirectResponse,
  interceptRedirectForPartial,
  attachLocationStateIfPresent,
} from "./helpers.js";
import { warnNonRedirectActionResponse } from "./runtime-warnings.js";
import type { HandlerContext } from "./handler-context.js";

/**
 * Data flowing from action execution to the revalidation phase.
 * When the action completes without redirect/error-boundary, the handler
 * passes this to route middleware → revalidateAfterAction.
 */
export interface ActionContinuation {
  returnValue: { ok: boolean; data: unknown };
  actionStatus: number;
  temporaryReferences: ReturnType<
    HandlerContext["createTemporaryReferenceSet"]
  >;
  actionContext: {
    actionId: string;
    actionUrl: URL;
    actionResult: unknown;
    formData?: FormData;
  };
}

/**
 * Phase 1: Execute the server action.
 *
 * Decodes arguments, runs the action, handles redirects and error
 * boundaries. Returns a final Response (redirect, error boundary render)
 * or an ActionContinuation for the revalidation phase.
 */
export async function executeServerAction<TEnv>(
  ctx: HandlerContext<TEnv>,
  request: Request,
  env: TEnv,
  url: URL,
  actionId: string,
  handleStore: ReturnType<typeof requireRequestContext>["_handleStore"],
): Promise<Response | ActionContinuation> {
  const temporaryReferences = ctx.createTemporaryReferenceSet();

  // Decode action arguments from request body
  const contentType = request.headers.get("content-type") || "";
  let args: unknown[] = [];
  let actionFormData: FormData | undefined;

  try {
    const body = contentType.includes("multipart/form-data")
      ? await request.formData()
      : await request.text();

    if (body instanceof FormData) {
      actionFormData = body;
    }

    if (hasBodyContent(body)) {
      args = await ctx.decodeReply(body, { temporaryReferences });
    }
  } catch (error) {
    throw new Error(`Failed to decode action arguments: ${error}`, {
      cause: error,
    });
  }

  // Execute the server action
  let returnValue: { ok: boolean; data: unknown };
  let actionStatus = 200;
  let loadedAction: Function | undefined;

  try {
    loadedAction = await ctx.loadServerAction(actionId);
    let data = await loadedAction!.apply(null, args);

    // Intercept redirect Responses: serializing one as the action returnValue
    // would fail, and revalidation would run needlessly.
    if (data instanceof Response) {
      const intercepted = interceptRedirectForPartial(
        data,
        ctx.createRedirectFlightResponse,
      );
      if (intercepted) return intercepted;

      // Non-redirect Response returned (not thrown): a raw Response cannot be
      // serialized into Flight. Discard it and re-render — mirroring the PE
      // path (progressive-enhancement.ts) so JS and no-JS behave identically.
      if (process.env.NODE_ENV !== "production") {
        warnNonRedirectActionResponse(actionId);
      }
      data = undefined;
    }

    returnValue = { ok: true, data };
  } catch (error) {
    // Handle thrown redirect (e.g., throw redirect('/path'))
    if (error instanceof Response) {
      const intercepted = interceptRedirectForPartial(
        error,
        ctx.createRedirectFlightResponse,
      );
      if (intercepted) return intercepted;

      // Non-redirect Response thrown from action — this will be treated
      // as a regular error and routed to the error boundary. Warn in dev
      // since the intent is likely a redirect with a missing Location header.
      if (process.env.NODE_ENV !== "production") {
        console.warn(
          `[@rangojs/router] Server action "${actionId}" threw a Response ` +
            `(status ${error.status}) that is not a redirect. ` +
            `Non-redirect Responses are treated as errors. ` +
            `Use \`throw redirect('/path')\` for redirects.`,
        );
      }
    }

    returnValue = { ok: false, data: error };
    actionStatus = 500;

    // Try to render error boundary.
    // Report the action error first so it is not lost if matchError throws.
    let errorResult;
    try {
      errorResult = await ctx.router.matchError(
        request,
        { env },
        error,
        "route",
      );
    } catch (matchErr) {
      // matchError failed — report the original action error as unhandled,
      // then let the matchError failure propagate.
      ctx.callOnError(error, "action", {
        request,
        url,
        env,
        actionId,
        handledByBoundary: false,
      });
      throw matchErr;
    }

    ctx.callOnError(error, "action", {
      request,
      url,
      env,
      actionId,
      handledByBoundary: !!errorResult,
    });

    if (errorResult) {
      setRequestContextParams(errorResult.params, errorResult.routeName);

      const payload: RscPayload = {
        metadata: {
          pathname: url.pathname,
          // routerId exposed for the frontend (current app identity); see
          // rsc-rendering.ts partial branch.
          routerId: ctx.router.id,
          segments: errorResult.segments,
          isPartial: true,
          matched: errorResult.matched,
          diff: errorResult.diff,
          resolvedIds: errorResult.resolvedIds,
          params: errorResult.params,
          isError: true,
          handles: handleStore.stream(),
          version: ctx.version,
        },
        returnValue,
      };

      // Intentionally omit attachLocationState for error payloads:
      // location state is a success-only semantic. Error boundary responses
      // update the error UI but should not mutate browser history state.

      const rscStream = ctx.renderToReadableStream<RscPayload>(payload, {
        temporaryReferences,
        onError: (error: unknown) => {
          ctx.callOnError(error, "rendering", { request, url, env });
        },
      });

      return createResponseWithMergedHeaders(rscStream, {
        status: actionStatus,
        headers: {
          "content-type": "text/x-component;charset=utf-8",
          // Router identity for the client's pre-decode integrity check (the
          // action apply path has no post-decode guard). See response-adapter.
          "X-RSC-Router-Id": ctx.router.id,
        },
      });
    }
  }

  // Build continuation for the revalidation phase
  const actionMeta = loadedAction as
    | { $id?: string; $$id?: string }
    | undefined;
  const resolvedActionId = actionMeta?.$id ?? actionMeta?.$$id ?? actionId;

  return {
    returnValue,
    actionStatus,
    temporaryReferences,
    actionContext: {
      // Defensive copy of the already-parsed url (avoids re-parsing
      // request.url). actionUrl is persisted into the continuation and later
      // flows into matchPartial, so it must not alias the handler's live url.
      actionId: resolvedActionId,
      actionUrl: new URL(url),
      actionResult: returnValue.data,
      formData: actionFormData,
    },
  };
}

/**
 * Phase 2: Revalidate after action.
 *
 * Matches affected segments, builds the RSC payload, and returns the
 * Flight response. Called inside route middleware (same as a normal render).
 *
 * Invariant: the response payload MUST have isPartial: true. The client
 * (server-action-bridge) rejects non-partial payloads because partial
 * reconciliation requires matched/diff semantics that full renders don't
 * provide. Redirects are the only non-partial outcome and are handled via
 * X-RSC-Redirect headers before Flight deserialization.
 */
export async function revalidateAfterAction<TEnv>(
  ctx: HandlerContext<TEnv>,
  request: Request,
  env: TEnv,
  url: URL,
  handleStore: ReturnType<typeof requireRequestContext>["_handleStore"],
  continuation: ActionContinuation,
): Promise<Response> {
  const { returnValue, actionStatus, temporaryReferences, actionContext } =
    continuation;
  const reqCtx = requireRequestContext();
  const metricsStore = reqCtx._metricsStore;

  const matchResult = await ctx.router.matchPartial(
    request,
    { env },
    actionContext,
  );

  if (!matchResult) {
    // matchPartial returns null when the route is a redirect or no previous-URL
    // context could be resolved. Check for redirect first.
    const fullMatch = await ctx.router.match(request, { env });
    setRequestContextParams(fullMatch.params, fullMatch.routeName);

    if (fullMatch.redirect) {
      // Action context is always partial — use X-RSC-Redirect header so
      // the client can perform SPA navigation instead of fetch auto-following
      // a raw 308 to a URL that would render full HTML.
      return createSimpleRedirectResponse(fullMatch.redirect);
    }

    // Non-redirect: this branch is only reachable when no previous URL could
    // be resolved (neither X-RSC-Router-Client-Path nor a usable Referer), or
    // the previous URL was unparseable (defensive). The client requires
    // isPartial for action responses, so producing a full payload here would
    // be rejected. Return 500 instead.
    throw new Error(
      `[RSC] matchPartial returned null for a non-redirect route ` +
        `during action revalidation (${url.pathname}). This indicates ` +
        `a malformed action request: no previous-URL context could be ` +
        `resolved (neither X-RSC-Router-Client-Path nor a usable Referer), ` +
        `or the previous URL was unparseable.`,
    );
  }

  // Return updated segments
  setRequestContextParams(matchResult.params, matchResult.routeName);

  const payload: RscPayload = {
    metadata: {
      pathname: url.pathname,
      // routerId exposed for the frontend (current app identity); see
      // rsc-rendering.ts partial branch.
      routerId: ctx.router.id,
      segments: matchResult.segments,
      isPartial: true,
      matched: matchResult.matched,
      diff: matchResult.diff,
      resolvedIds: matchResult.resolvedIds,
      params: matchResult.params,
      slots: matchResult.slots,
      handles: handleStore.stream(),
      version: ctx.version,
    },
    returnValue,
  };

  attachLocationStateIfPresent(payload);

  const renderStart = performance.now();
  const rscStream = ctx.renderToReadableStream<RscPayload>(payload, {
    temporaryReferences,
    onError: (error: unknown) => {
      ctx.callOnError(error, "rendering", { request, url, env });
    },
  });
  const rscSerializeDur = performance.now() - renderStart;
  // This measures synchronous stream creation, not end-to-end stream consumption.
  appendMetric(metricsStore, "rsc-serialize", renderStart, rscSerializeDur);
  appendMetric(
    metricsStore,
    "render:total",
    renderStart,
    performance.now() - renderStart,
  );

  return createResponseWithMergedHeaders(rscStream, {
    status: actionStatus,
    headers: {
      "content-type": "text/x-component;charset=utf-8",
      // Router identity for the client's pre-decode integrity check (the action
      // apply path has no post-decode guard). See response-adapter.
      "X-RSC-Router-Id": ctx.router.id,
    },
  });
}
