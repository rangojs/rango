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
import type { RscPayload, ReactFormState } from "./types.js";
import { createResponseWithMergedHeaders } from "./helpers.js";
import type { HandlerContext } from "./handler-context.js";

export async function handleProgressiveEnhancement<TEnv>(
  ctx: HandlerContext<TEnv>,
  request: Request,
  env: TEnv,
  url: URL,
  isAction: boolean,
  handleStore: ReturnType<typeof requireRequestContext>["_handleStore"],
  nonce: string | undefined,
): Promise<Response | null> {
  const contentType = request.headers.get("content-type") || "";
  const isFormSubmission =
    contentType.includes("multipart/form-data") ||
    contentType.includes("application/x-www-form-urlencoded");

  if (request.method !== "POST" || isAction || !isFormSubmission) {
    return null;
  }

  // Clone the request to read FormData without consuming it
  const formData = await request.clone().formData();

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
    try {
      const boundAction = await ctx.decodeAction(formData);
      actionResult = await boundAction();
    } catch (error) {
      ctx.callOnError(error, "action", {
        request,
        url,
        env,
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

  // Re-render the page and return HTML
  const renderRequest = new Request(url.toString(), {
    method: "GET",
    headers: new Headers({ accept: "text/html" }),
  });

  const match = await ctx.router.match(renderRequest, env);

  if (match.redirect) {
    return createResponseWithMergedHeaders(null, {
      status: 308,
      headers: { Location: match.redirect },
    });
  }

  const payload: RscPayload = {
    metadata: {
      pathname: url.pathname,
      segments: match.segments,
      matched: match.matched,
      diff: match.diff,
      isPartial: false,
      rootLayout: ctx.router.rootLayout,
      handles: handleStore.stream(),
      version: ctx.version,
      themeConfig: ctx.router.themeConfig,
      warmupEnabled: ctx.router.warmupEnabled,
      initialTheme: requireRequestContext().theme,
    },
    formState: actionResult,
  };

  const rscStream = ctx.renderToReadableStream<RscPayload>(payload);
  const ssrModule = await ctx.loadSSRModule();
  const htmlStream = await ssrModule.renderHTML(rscStream, {
    formState: reactFormState,
    nonce,
  });

  return createResponseWithMergedHeaders(htmlStream, {
    headers: { "content-type": "text/html;charset=utf-8" },
  });
}
