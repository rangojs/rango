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
  getLocationState,
} from "../server/request-context.js";
import { resolveLocationStateEntries } from "../browser/react/location-state-shared.js";
import type { RscPayload } from "./types.js";
import {
  hasBodyContent,
  createResponseWithMergedHeaders,
  createSimpleRedirectResponse,
} from "./helpers.js";
import type { HandlerContext } from "./handler-context.js";

/**
 * Attach location state set during the action to a payload's metadata.
 * No-op if no location state was set.
 */
function attachLocationState(payload: RscPayload): void {
  const locationState = getLocationState();
  if (locationState) {
    payload.metadata!.locationState =
      resolveLocationStateEntries(locationState);
  }
}

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
    const data = await loadedAction!.apply(null, args);

    // Intercept redirect responses from actions. Without this, the redirect
    // Response would be serialized as the action returnValue (which fails)
    // and the revalidation step would run unnecessarily.
    if (data instanceof Response) {
      const redirectUrl = data.headers.get("Location");
      const isRedirect = data.status >= 300 && data.status < 400 && redirectUrl;
      if (isRedirect) {
        const locationState = getLocationState();
        if (locationState) {
          // Redirect with state: needs Flight payload to carry state
          return ctx.createRedirectFlightResponse(
            redirectUrl,
            resolveLocationStateEntries(locationState),
          );
        }
        // Simple redirect: short-circuit with a header, no RSC serialization
        return createSimpleRedirectResponse(redirectUrl);
      }
    }

    returnValue = { ok: true, data };
  } catch (error) {
    // Handle thrown redirect (e.g., throw redirect('/path'))
    if (error instanceof Response) {
      const redirectUrl = error.headers.get("Location");
      const isRedirect =
        error.status >= 300 && error.status < 400 && redirectUrl;
      if (isRedirect) {
        const locationState = getLocationState();
        if (locationState) {
          return ctx.createRedirectFlightResponse(
            redirectUrl,
            resolveLocationStateEntries(locationState),
          );
        }
        return createSimpleRedirectResponse(redirectUrl);
      }
    }

    returnValue = { ok: false, data: error };
    actionStatus = 500;

    // Try to render error boundary
    const errorResult = await ctx.router.matchError(
      request,
      { env },
      error,
      "route",
    );

    // Report the action error (handledByBoundary indicates if error boundary will render)
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
          segments: errorResult.segments,
          isPartial: true,
          matched: errorResult.matched,
          diff: errorResult.diff,
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
      });

      return createResponseWithMergedHeaders(rscStream, {
        status: actionStatus,
        headers: { "content-type": "text/x-component;charset=utf-8" },
      });
    }
  }

  // Build continuation for the revalidation phase
  const resolvedActionId =
    (loadedAction as { $id?: string; $$id?: string } | undefined)?.$id ??
    (loadedAction as { $$id?: string } | undefined)?.$$id ??
    actionId;

  return {
    returnValue,
    actionStatus,
    temporaryReferences,
    actionContext: {
      actionId: resolvedActionId,
      actionUrl: new URL(request.url),
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

  const matchResult = await ctx.router.matchPartial(
    request,
    { env },
    actionContext,
  );

  if (!matchResult) {
    // Fall back to full render
    const fullMatch = await ctx.router.match(request, { env });
    setRequestContextParams(fullMatch.params, fullMatch.routeName);

    if (fullMatch.redirect) {
      // Action context is always partial — use X-RSC-Redirect header so
      // the client can perform SPA navigation instead of fetch auto-following
      // a raw 308 to a URL that would render full HTML.
      return createSimpleRedirectResponse(fullMatch.redirect);
    }

    const serverTiming = fullMatch.serverTiming;

    const payload: RscPayload = {
      metadata: {
        pathname: url.pathname,
        segments: fullMatch.segments,
        matched: fullMatch.matched,
        diff: fullMatch.diff,
        rootLayout: ctx.router.rootLayout,
        handles: handleStore.stream(),
        version: ctx.version,
      },
      returnValue,
    };

    attachLocationState(payload);

    const rscStream = ctx.renderToReadableStream<RscPayload>(payload, {
      temporaryReferences,
    });

    const headers: Record<string, string> = {
      "content-type": "text/x-component;charset=utf-8",
    };
    if (serverTiming) {
      headers["Server-Timing"] = serverTiming;
    }

    return createResponseWithMergedHeaders(rscStream, {
      status: actionStatus,
      headers,
    });
  }

  // Return updated segments
  setRequestContextParams(matchResult.params, matchResult.routeName);

  const serverTiming = matchResult.serverTiming;

  const payload: RscPayload = {
    metadata: {
      pathname: url.pathname,
      segments: matchResult.segments,
      isPartial: true,
      matched: matchResult.matched,
      diff: matchResult.diff,
      slots: matchResult.slots,
      handles: handleStore.stream(),
      version: ctx.version,
    },
    returnValue,
  };

  attachLocationState(payload);

  const rscStream = ctx.renderToReadableStream<RscPayload>(payload, {
    temporaryReferences,
  });

  const actionHeaders: Record<string, string> = {
    "content-type": "text/x-component;charset=utf-8",
  };
  if (serverTiming) {
    actionHeaders["Server-Timing"] = serverTiming;
  }

  return createResponseWithMergedHeaders(rscStream, {
    status: actionStatus,
    headers: actionHeaders,
  });
}
