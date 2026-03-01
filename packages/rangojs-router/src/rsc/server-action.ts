/**
 * Server Action Handler
 *
 * Handles server action execution and post-action revalidation.
 * Decodes action arguments, executes the action, handles redirects
 * and error boundaries, then revalidates affected segments.
 */

import {
  getRequestContext,
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
import { mergeCookiesForInlineRedirect } from "./cookie-merge.js";
import type { HandlerContext } from "./handler-context.js";

/**
 * Render the redirect target inline in the action response.
 * Creates a synthetic GET request for the redirect URL, merges cookies
 * set during the action, and calls matchPartial to render the target.
 * Returns null if inline rendering fails (caller falls back to simple redirect).
 */
async function renderInlineRedirect<TEnv>(
  ctx: HandlerContext<TEnv>,
  originalRequest: Request,
  env: TEnv,
  redirectUrl: string,
  actionContext: {
    actionId?: string;
    actionUrl?: URL;
    actionResult?: unknown;
    formData?: FormData;
  },
  returnValue: { ok: boolean; data: unknown },
  handleStore: ReturnType<typeof requireRequestContext>["_handleStore"],
  temporaryReferences: ReturnType<
    HandlerContext<TEnv>["createTemporaryReferenceSet"]
  >,
): Promise<Response | null> {
  try {
    // Build the synthetic URL for the redirect target
    const originalUrl = new URL(originalRequest.url);
    const targetUrl = new URL(redirectUrl, originalUrl.origin);
    targetUrl.searchParams.set("_rsc_partial", "true");
    // Empty _rsc_segments forces the server to render all segments fresh
    targetUrl.searchParams.set("_rsc_segments", "");

    // Replay Set-Cookie headers into the request context's cookie cache
    // so that ctx.cookie() on the redirect target sees cookies set by the action.
    const reqCtx = getRequestContext();
    reqCtx?._replayCookiesFromResponse();

    // Also merge cookies into the synthetic request's Cookie header for
    // any new middleware contexts that may be created during matchPartial.
    const setCookieHeaders = reqCtx?.res.headers.getSetCookie() ?? [];
    const mergedCookieHeader = mergeCookiesForInlineRedirect(
      originalRequest.headers.get("Cookie"),
      setCookieHeaders,
    );

    // Create synthetic GET request for the redirect target
    const syntheticHeaders = new Headers(originalRequest.headers);
    syntheticHeaders.set("Cookie", mergedCookieHeader);
    syntheticHeaders.set(
      "X-RSC-Router-Client-Path",
      originalUrl.pathname + originalUrl.search,
    );
    // Remove action-specific headers
    syntheticHeaders.delete("Content-Type");
    syntheticHeaders.delete("Content-Length");

    const syntheticRequest = new Request(targetUrl.toString(), {
      method: "GET",
      headers: syntheticHeaders,
    });

    const matchResult = await ctx.router.matchPartial(
      syntheticRequest,
      env,
      actionContext,
    );

    if (!matchResult) return null;

    // If the target itself redirects, fall back to simple redirect
    if (matchResult.redirect) return null;

    setRequestContextParams(matchResult.params, matchResult.routeName);

    const payload: RscPayload = {
      metadata: {
        pathname: targetUrl.pathname,
        segments: matchResult.segments,
        isPartial: true,
        matched: matchResult.matched,
        diff: matchResult.diff,
        slots: matchResult.slots,
        handles: handleStore.stream(),
        version: ctx.version,
        inlineRedirect: { url: redirectUrl },
      },
      returnValue,
    };

    const rscStream = ctx.renderToReadableStream<RscPayload>(payload, {
      temporaryReferences,
    });

    const headers: Record<string, string> = {
      "content-type": "text/x-component;charset=utf-8",
    };
    if (matchResult.serverTiming) {
      headers["Server-Timing"] = matchResult.serverTiming;
    }

    return createResponseWithMergedHeaders(rscStream, {
      status: 200,
      headers,
    });
  } catch {
    // If anything goes wrong, fall back to simple redirect
    return null;
  }
}

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
        // Try inline redirect: render target directly in action response
        const resolvedId =
          (loadedAction as { $id?: string; $$id?: string } | undefined)?.$id ??
          (loadedAction as { $$id?: string } | undefined)?.$$id ??
          actionId;
        const inlineResponse = await renderInlineRedirect(
          ctx,
          request,
          env,
          redirectUrl,
          {
            actionId: resolvedId,
            actionUrl: new URL(request.url),
            formData: actionFormData,
          },
          { ok: true, data: undefined },
          handleStore,
          temporaryReferences,
        );
        if (inlineResponse) return inlineResponse;
        // Fall back to simple redirect
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
        // Try inline redirect: render target directly in action response
        const resolvedId =
          (loadedAction as { $id?: string; $$id?: string } | undefined)?.$id ??
          (loadedAction as { $$id?: string } | undefined)?.$$id ??
          actionId;
        const inlineResponse = await renderInlineRedirect(
          ctx,
          request,
          env,
          redirectUrl,
          {
            actionId: resolvedId,
            actionUrl: new URL(request.url),
            formData: actionFormData,
          },
          { ok: true, data: undefined },
          handleStore,
          temporaryReferences,
        );
        if (inlineResponse) return inlineResponse;
        // Fall back to simple redirect
        return createSimpleRedirectResponse(redirectUrl);
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
