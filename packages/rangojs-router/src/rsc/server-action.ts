/**
 * Server Action Handler
 *
 * Handles server action execution and post-action revalidation.
 * Decodes action arguments, executes the action, handles redirects
 * and error boundaries, then revalidates affected segments.
 */

import {
  requireRequestContext,
  setRequestContextParams,
  getLocationState,
} from "../server/request-context.js";
import { resolveLocationStateEntries } from "../browser/react/location-state-shared.js";
import type { RscPayload } from "./types.js";
import { hasBodyContent, createResponseWithMergedHeaders } from "./helpers.js";
import type { HandlerContext } from "./handler-context.js";

export async function handleServerAction<TEnv>(
  ctx: HandlerContext<TEnv>,
  request: Request,
  env: TEnv,
  url: URL,
  actionId: string,
  handleStore: ReturnType<typeof requireRequestContext>["_handleStore"],
): Promise<Response> {
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
        return createResponseWithMergedHeaders(null, {
          status: 204,
          headers: { "X-RSC-Redirect": redirectUrl },
        });
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
        return createResponseWithMergedHeaders(null, {
          status: 204,
          headers: { "X-RSC-Redirect": redirectUrl },
        });
      }
    }

    returnValue = { ok: false, data: error };
    actionStatus = 500;

    // Try to render error boundary
    const errorResult = await ctx.router.matchError(
      request,
      env,
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
      setRequestContextParams(errorResult.params);

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

      const rscStream = ctx.renderToReadableStream<RscPayload>(payload, {
        temporaryReferences,
      });

      return createResponseWithMergedHeaders(rscStream, {
        status: actionStatus,
        headers: { "content-type": "text/x-component;charset=utf-8" },
      });
    }
  }

  // Revalidate after action
  const resolvedActionId =
    (loadedAction as { $id?: string; $$id?: string } | undefined)?.$id ??
    (loadedAction as { $$id?: string } | undefined)?.$$id ??
    actionId;
  const actionContext = {
    actionId: resolvedActionId,
    actionUrl: new URL(request.url),
    actionResult: returnValue.data,
    formData: actionFormData,
  };

  const matchResult = await ctx.router.matchPartial(
    request,
    env,
    actionContext,
  );

  if (!matchResult) {
    // Fall back to full render
    const fullMatch = await ctx.router.match(request, env);
    setRequestContextParams(fullMatch.params);

    if (fullMatch.redirect) {
      return createResponseWithMergedHeaders(null, {
        status: 308,
        headers: { Location: fullMatch.redirect },
      });
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
  setRequestContextParams(matchResult.params);

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
