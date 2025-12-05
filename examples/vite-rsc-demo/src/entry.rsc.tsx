import {
  renderToReadableStream,
  decodeReply,
  createTemporaryReferenceSet,
  decodeAction,
  loadServerAction,
} from "@vitejs/plugin-rsc/rsc";
import { router } from "./router.js";
import {
  renderSegments,
  type ResolvedSegment,
  type SlotState,
} from "rsc-router/server";

/**
 * RSC Payload Schema
 */
export type RscPayload = {
  root: React.ReactNode;
  metadata?: {
    pathname: string;
    segments: ResolvedSegment[];
    isPartial?: boolean;
    isError?: boolean;
    matched?: string[];
    diff?: string[];
    /** State of named slots for this route match (used for intercepting routes) */
    slots?: Record<string, SlotState>;
  };
  returnValue?: { ok: boolean; data: any }; // Action return value
  formState?: any; // Form state (future)
};

/**
 * Main entry point - handles RSC requests
 */
export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const isPartial = url.searchParams.has("_rsc_partial");
  const isAction =
    request.headers.has("rsc-action") || url.searchParams.has("_rsc_action");
  const actionId =
    request.headers.get("rsc-action") || url.searchParams.get("_rsc_action");

  console.log(`\n[RSC] ${request.method} ${url.pathname}${url.search}`);
  console.log(`[RSC] Partial: ${isPartial}`);
  console.log(`[RSC] Action: ${isAction ? actionId : "none"}`);

  let payload: RscPayload;

  try {
    // ============================================================================
    // SERVER ACTION EXECUTION
    // ============================================================================
    if (isAction && actionId) {
      console.log(`[RSC] >>> ACTION REQUEST: ${actionId}`);

      // 1. Create temporary references for decoding arguments
      const temporaryReferences = createTemporaryReferenceSet();

      // 2. Decode action arguments from request body
      // decodeReply can handle FormData or text body automatically
      const contentType = request.headers.get("content-type") || "";
      console.log(`[RSC] Content-Type: ${contentType}`);

      let args: any[] = [];
      let actionFormData: FormData | undefined;

      try {
        // decodeReply accepts FormData or text - get the appropriate body
        const body = contentType.includes("multipart/form-data")
          ? await request.formData()
          : await request.text();

        console.log(
          `[RSC] Body type:`,
          body instanceof FormData ? "FormData" : "text"
        );

        // Store FormData for revalidation context
        if (body instanceof FormData) {
          actionFormData = body;
        }

        if (
          (body instanceof FormData && body.entries().next().done === false) ||
          (typeof body === "string" && body.length > 0)
        ) {
          args = await decodeReply(body, { temporaryReferences });
          console.log(`[RSC] Action args decoded:`, args);
        } else {
          console.log(`[RSC] Empty body, using empty args`);
        }
      } catch (error) {
        console.error(`[RSC] Failed to decode args:`, error);
        throw new Error(`Failed to decode action arguments: ${error}`);
      }

      // 3. Load and execute the server action using official Vite RSC API
      console.log(`[RSC] Loading action: ${actionId}`);

      let returnValue: { ok: boolean; data: any };
      let actionStatus = 200;

      try {
        // Use official loadServerAction API (handles Vite's module loading)
        const action = await loadServerAction(actionId);

        console.log(`[RSC] Executing action with args:`, args);

        // Execute the action with decoded arguments
        const data = await action.apply(null, args);

        returnValue = { ok: true, data };
        console.log(`[RSC] Action executed successfully, result:`, data);
      } catch (error) {
        console.error(`[RSC] Action execution error:`, error);
        returnValue = { ok: false, data: error };
        actionStatus = 500;

        // Use matchError to render the error boundary
        const errorResult = await router.matchError(request, {}, error, "route");

        if (errorResult) {
          console.log(`[RSC] Rendering error boundary for action error`);

          const renderStart = performance.now();
          const root = renderSegments(errorResult.segments);
          const renderDuration = performance.now() - renderStart;

          payload = {
            root: null,
            metadata: {
              pathname: url.pathname,
              segments: errorResult.segments,
              isPartial: true,
              matched: errorResult.matched,
              diff: errorResult.diff,
              isError: true, // Flag to indicate this is an error response
            },
            returnValue, // Include the error for client-side awareness
          };

          const rscStream = renderToReadableStream<RscPayload>(payload, {
            temporaryReferences,
          });

          console.log(`[RSC] Action error - returning error boundary UI`);

          return new Response(rscStream, {
            status: actionStatus,
            headers: {
              "content-type": "text/x-component;charset=utf-8",
              "Server-Timing": `rendering;dur=${renderDuration.toFixed(2)}`,
            },
          });
        }

        // If matchError returns null (shouldn't happen with default fallback), continue to normal flow
        console.warn(`[RSC] matchError returned null, continuing with normal flow`);
      }

      // 5. Revalidate to determine which segments need updating
      console.log(`[RSC] Running revalidation after action...`);

      // Build action context for revalidation functions
      // Extract just the function name (after #) for consistent behavior between dev and production
      // In dev: actionId = "file:///path/to/actions.ts#functionName"
      // In prod: actionId = "abc123#functionName" (hashed filename)
      const actionName = actionId.includes("#")
        ? actionId.split("#").pop()!
        : actionId;

      const actionContext = {
        actionId: actionName,
        actionUrl: new URL(request.url),
        actionResult: returnValue.data, // Pass the unwrapped result
        formData: actionFormData,
      };

      console.log(`[RSC] Action context for revalidation:`, {
        actionId: actionContext.actionId,
        actionUrl: actionContext.actionUrl.href,
        hasFormData: !!actionContext.formData,
        hasResult: actionContext.actionResult !== undefined,
      });

      const matchResult = await router.matchPartial(request, {}, actionContext);

      if (!matchResult) {
        // Fall back to full render if partial match fails
        console.log(
          `[RSC] Partial match failed after action, falling back to full render`
        );
        const fullMatch = await router.match(request, {});
        const renderStart = performance.now();
        const root = renderSegments(fullMatch.segments);
        const renderDuration = performance.now() - renderStart;
        const actionServerTiming = fullMatch.serverTiming
          ? `${fullMatch.serverTiming}, rendering;dur=${renderDuration.toFixed(2)}`
          : `rendering;dur=${renderDuration.toFixed(2)}`;

        payload = {
          root,
          metadata: {
            pathname: url.pathname,
            segments: fullMatch.segments,
            matched: fullMatch.matched,
            diff: fullMatch.diff,
          },
          returnValue, // Include action result
        };

        const rscStream = renderToReadableStream<RscPayload>(payload, {
          temporaryReferences,
        });

        console.log(
          `[RSC] Action complete - returning full render with returnValue`
        );

        const headers: Record<string, string> = {
          "content-type": "text/x-component;charset=utf-8",
        };
        if (actionServerTiming) {
          headers["Server-Timing"] = actionServerTiming;
        }

        return new Response(rscStream, {
          status: actionStatus,
          headers,
        });
      }

      // 6. Return updated segments (same format as partial navigation)
      const renderStart2 = performance.now();
      const root = renderSegments(matchResult.segments);
      const renderDuration2 = performance.now() - renderStart2;
      const partialServerTiming = matchResult.serverTiming
        ? `${matchResult.serverTiming}, rendering;dur=${renderDuration2.toFixed(2)}`
        : `rendering;dur=${renderDuration2.toFixed(2)}`;

      payload = {
        root: null,
        metadata: {
          pathname: url.pathname,
          segments: matchResult.segments,
          isPartial: true,
          matched: matchResult.matched,
          diff: matchResult.diff,
          slots: matchResult.slots,
        },
        returnValue, // Include action result
      };

      const rscStream = renderToReadableStream<RscPayload>(payload, {
        temporaryReferences,
      });

      console.log(
        `[RSC] Action complete - returning updated segments with returnValue`
      );
      console.log(`[RSC] Matched: ${matchResult.matched.join(", ")}`);
      console.log(`[RSC] Diff: ${matchResult.diff.join(", ")}`);
      console.log(`[RSC] Return value:`, returnValue);

      const actionHeaders: Record<string, string> = {
        "content-type": "text/x-component;charset=utf-8",
      };
      if (partialServerTiming) {
        actionHeaders["Server-Timing"] = partialServerTiming;
      }

      return new Response(rscStream, {
        status: actionStatus,
        headers: actionHeaders,
      });
    }

    // ============================================================================
    // REGULAR RSC RENDERING (Navigation)
    // ============================================================================
    let serverTiming: string | undefined;

    if (isPartial) {
      // Partial render (navigation)
      console.log(`[RSC] >>> PARTIAL RENDER`);
      const result = await router.matchPartial(request, {});

      if (!result) {
        // Fall back to full render
        console.warn(`[RSC] Partial match failed, falling back to full`);
        const match = await router.match(request, {});
        const renderStart = performance.now();
        const root = renderSegments(match.segments);
        const renderDuration = performance.now() - renderStart;
        serverTiming = match.serverTiming
          ? `${match.serverTiming}, rendering;dur=${renderDuration.toFixed(2)}`
          : `rendering;dur=${renderDuration.toFixed(2)}`;

        payload = {
          root,
          metadata: {
            pathname: url.pathname,
            segments: match.segments,
            matched: match.matched,
            diff: match.diff,
            isPartial: false,
          },
        };
      } else {
        serverTiming = result.serverTiming;
        payload = {
          root: null,
          metadata: {
            pathname: url.pathname,
            segments: result.segments,
            matched: result.matched,
            diff: result.diff,
            isPartial: true,
            slots: result.slots,
          },
        };
      }
    } else {
      // Full render (initial page load)
      console.warn(`[RSC] >>> FULL RENDER`);
      const match = await router.match(request, {});
      const renderStart = performance.now();

      // Render segments
      const root = renderSegments(match.segments);

      const renderDuration = performance.now() - renderStart;
      serverTiming = match.serverTiming
        ? `${match.serverTiming}, rendering;dur=${renderDuration.toFixed(2)}`
        : `rendering;dur=${renderDuration.toFixed(2)}`;

      payload = {
        root,
        metadata: {
          pathname: url.pathname,
          segments: match.segments, // Send full segments WITH components for initial hydration
          matched: match.matched,
          diff: match.diff,
          isPartial: false,
        },
      };
    }

    console.log(`[RSC] ✓ Payload ready`);
    console.log(
      `[RSC] Segments:`,
      payload.metadata?.segments?.map((s) => s.id).join(", ")
    );

    // Serialize to RSC stream
    const rscStream = renderToReadableStream<RscPayload>(payload);

    // Determine if this is an RSC request or HTML request
    const isRscRequest =
      (!request.headers.get("accept")?.includes("text/html") &&
        !url.searchParams.has("__html")) ||
      url.searchParams.has("__rsc");

    if (isRscRequest) {
      // Return RSC stream for client navigation
      console.log(`[RSC] → Returning RSC stream`);
      const rscHeaders: Record<string, string> = {
        "content-type": "text/x-component;charset=utf-8",
        vary: "accept",
      };
      if (serverTiming) {
        rscHeaders["Server-Timing"] = serverTiming;
      }
      return new Response(rscStream, {
        headers: rscHeaders,
      });
    }

    // Delegate to SSR for HTML response (document requests)
    console.log(`[RSC] → Delegating to SSR for HTML`);
    const ssrEntryModule = await import.meta.viteRsc.loadModule<
      typeof import("./entry.ssr.js")
    >("ssr", "index");

    const htmlStream = await ssrEntryModule.renderHTML(rscStream);

    const htmlHeaders: Record<string, string> = {
      "content-type": "text/html;charset=utf-8",
    };
    if (serverTiming) {
      htmlHeaders["Server-Timing"] = serverTiming;
    }

    return new Response(htmlStream, {
      headers: htmlHeaders,
    });
  } catch (error) {
    // Check if middleware/handler returned Response (redirect, auth, etc.)
    if (error instanceof Response) {
      console.log(
        `[RSC] Middleware/handler returned Response - returning directly`
      );
      return error;
    }

    // Actual error - log and re-throw
    console.error(`[RSC] Error:`, error);
    throw error;
  }
}
