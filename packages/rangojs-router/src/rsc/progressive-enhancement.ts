/**
 * Progressive Enhancement Handler
 *
 * Handles no-JS form submissions. When JavaScript is disabled, React renders
 * forms with hidden fields ($ACTION_REF_*, $ACTION_KEY) containing the action
 * reference. We detect these and return HTML instead of RSC stream.
 */

import {
  requireRequestContext,
  setRequestContextParams,
} from "../server/request-context.js";
import { getSSRSetup } from "./ssr-setup.js";
import type { MiddlewareFn } from "../router/middleware.js";
import { executeMiddleware } from "../router/middleware.js";
import type { RscPayload, ReactFormState } from "./types.js";
import {
  createResponseWithMergedHeaders,
  finalizeResponse,
  buildRouteMiddlewareEntries,
} from "./helpers.js";
import type { HandlerContext } from "./handler-context.js";
import {
  extractRedirectResponse,
  warnNonRedirectPeResponse,
} from "./runtime-warnings.js";

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
  handleStore: ReturnType<typeof requireRequestContext>["_handleStore"],
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

  if (isUseActionState) {
    // Decode and extract action identity before execution so error
    // handlers can report actionId even when the action throws.
    let useActionStateId: string | undefined;
    try {
      const boundAction = await ctx.decodeAction(formData);
      // React's custom .bind() preserves $$id on server references.
      useActionStateId = (boundAction as { $$id?: string }).$$id ?? undefined;
      actionResult = await boundAction();
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
        useActionStateId,
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
    }
  } else if (isDirectAction && directActionId) {
    const temporaryReferences = ctx.createTemporaryReferenceSet();

    let args: unknown[] = [];
    try {
      args = await ctx.decodeReply(formData, { temporaryReferences });
    } catch {
      args = [formData];
    }

    try {
      const loadedAction = await ctx.loadServerAction(directActionId);
      actionResult = await loadedAction.apply(null, args);
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
        directActionId,
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
    const renderRequest = new Request(url.toString(), {
      method: "GET",
      headers: new Headers({ accept: "text/html" }),
    });

    const match = await ctx.router.match(renderRequest, { env });

    if (match.redirect) {
      return createResponseWithMergedHeaders(null, {
        status: 308,
        headers: { Location: match.redirect },
      });
    }

    const payload: RscPayload = {
      metadata: {
        pathname: url.pathname,
        routerId: ctx.router.id,
        basename: ctx.router.basename,
        segments: match.segments,
        matched: match.matched,
        diff: match.diff,
        resolvedIds: match.resolvedIds,
        params: match.params,
        isPartial: false,
        rootLayout: ctx.router.rootLayout,
        handles: handleStore.stream(),
        version: ctx.version,
        stateCookieName: ctx.router.resolvedStateCookieName,
        themeConfig: ctx.router.themeConfig,
        warmupEnabled: ctx.router.warmupEnabled,
        initialTheme: requireRequestContext().theme,
      },
    };

    const rscStream = ctx.renderToReadableStream<RscPayload>(payload, {
      onError: (error: unknown) => {
        ctx.callOnError(error, "rendering", { request, url, env });
      },
    });
    // metricsStore=undefined is safe: the handler already stashed the early
    // SSR setup promise on request variables, so getSSRSetup returns it
    // without falling back to a fresh startSSRSetup.
    const [ssrModule, streamMode] = await getSSRSetup(
      ctx,
      request,
      env,
      url,
      undefined,
    );
    // reactFormState carries the useActionState payload via the SSR-option path
    // (renderToReadableStream({ formState })); it does NOT travel on RscPayload.
    const htmlStream = await ssrModule.renderHTML(rscStream, {
      formState: reactFormState,
      nonce,
      streamMode,
    });

    return createResponseWithMergedHeaders(htmlStream, {
      headers: { "content-type": "text/html;charset=utf-8" },
    });
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
  handleStore: ReturnType<typeof requireRequestContext>["_handleStore"],
  nonce: string | undefined,
  actionId?: string | null,
): Promise<Response | null> {
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

  const payload: RscPayload = {
    metadata: {
      pathname: url.pathname,
      routerId: ctx.router.id,
      basename: ctx.router.basename,
      segments: errorResult.segments,
      matched: errorResult.matched,
      diff: errorResult.diff,
      resolvedIds: errorResult.resolvedIds,
      params: errorResult.params,
      isPartial: false,
      isError: true,
      rootLayout: ctx.router.rootLayout,
      handles: handleStore.stream(),
      version: ctx.version,
      stateCookieName: ctx.router.resolvedStateCookieName,
      themeConfig: ctx.router.themeConfig,
      warmupEnabled: ctx.router.warmupEnabled,
      initialTheme: requireRequestContext().theme,
    },
  };

  const rscStream = ctx.renderToReadableStream<RscPayload>(payload, {
    onError: (error: unknown) => {
      ctx.callOnError(error, "rendering", { request, url, env });
    },
  });
  // metricsStore=undefined is safe: the handler already stashed the early
  // SSR setup promise on request variables, so getSSRSetup returns it
  // without falling back to a fresh startSSRSetup.
  const [ssrModule, streamMode] = await getSSRSetup(
    ctx,
    request,
    env,
    url,
    undefined,
  );
  const htmlStream = await ssrModule.renderHTML(rscStream, {
    nonce,
    streamMode,
  });

  return createResponseWithMergedHeaders(htmlStream, {
    status: 500,
    headers: { "content-type": "text/html;charset=utf-8" },
  });
}
