import { renderSegments } from "../segment-system.js";
import type { RSCRouter } from "../router.js";
import type { ResolvedSegment, SlotState } from "../types.js";

/**
 * RSC payload sent to the client
 */
export interface RscPayload {
  root: React.ReactNode | Promise<React.ReactNode>;
  metadata?: {
    pathname: string;
    segments: ResolvedSegment[];
    isPartial?: boolean;
    isError?: boolean;
    matched?: string[];
    diff?: string[];
    slots?: Record<string, SlotState>;
  };
  returnValue?: { ok: boolean; data: unknown };
  formState?: unknown;
}

/**
 * RSC dependencies from @vitejs/plugin-rsc/rsc
 */
export interface RSCDependencies {
  /**
   * renderToReadableStream from @vitejs/plugin-rsc/rsc
   */
  renderToReadableStream: <T>(
    payload: T,
    options?: { temporaryReferences?: unknown }
  ) => ReadableStream<Uint8Array>;

  /**
   * decodeReply from @vitejs/plugin-rsc/rsc
   */
  decodeReply: (
    body: FormData | string,
    options?: { temporaryReferences?: unknown }
  ) => Promise<unknown[]>;

  /**
   * createTemporaryReferenceSet from @vitejs/plugin-rsc/rsc
   */
  createTemporaryReferenceSet: () => unknown;

  /**
   * loadServerAction from @vitejs/plugin-rsc/rsc
   */
  loadServerAction: (actionId: string) => Promise<Function>;
}

/**
 * SSR module interface for HTML rendering
 */
export interface SSRModule {
  renderHTML: (rscStream: ReadableStream<Uint8Array>) => Promise<ReadableStream<Uint8Array>>;
}

/**
 * Function to load SSR module dynamically
 */
export type LoadSSRModule = () => Promise<SSRModule>;

/**
 * Options for creating an RSC handler
 */
export interface CreateRSCHandlerOptions<TEnv = unknown> {
  /**
   * The RSC router instance
   */
  router: RSCRouter<TEnv>;

  /**
   * RSC dependencies from @vitejs/plugin-rsc/rsc
   */
  deps: RSCDependencies;

  /**
   * Function to load the SSR module for HTML rendering
   * Typically: () => import.meta.viteRsc.loadModule("ssr", "index")
   */
  loadSSRModule: LoadSSRModule;
}

/**
 * Create an RSC request handler.
 *
 * @example
 * ```tsx
 * import { createRSCHandler } from "rsc-router/rsc";
 * import {
 *   renderToReadableStream,
 *   decodeReply,
 *   createTemporaryReferenceSet,
 *   loadServerAction,
 * } from "@vitejs/plugin-rsc/rsc";
 * import { router } from "./router.js";
 *
 * export default createRSCHandler({
 *   router,
 *   deps: {
 *     renderToReadableStream,
 *     decodeReply,
 *     createTemporaryReferenceSet,
 *     loadServerAction,
 *   },
 *   loadSSRModule: () =>
 *     import.meta.viteRsc.loadModule<typeof import("./entry.ssr.js")>("ssr", "index"),
 * });
 * ```
 */
export function createRSCHandler<TEnv = unknown>(
  options: CreateRSCHandlerOptions<TEnv>
) {
  const { router, deps, loadSSRModule } = options;
  const {
    renderToReadableStream,
    decodeReply,
    createTemporaryReferenceSet,
    loadServerAction,
  } = deps;

  return async function handler(
    request: Request,
    env: TEnv = {} as TEnv
  ): Promise<Response> {
    const url = new URL(request.url);
    const isPartial = url.searchParams.has("_rsc_partial");
    const isAction =
      request.headers.has("rsc-action") || url.searchParams.has("_rsc_action");
    const actionId =
      request.headers.get("rsc-action") || url.searchParams.get("_rsc_action");

    let payload: RscPayload;

    try {
      // ============================================================================
      // SERVER ACTION EXECUTION
      // ============================================================================
      if (isAction && actionId) {
        const temporaryReferences = createTemporaryReferenceSet();

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

          // Check if body has content to decode
          let hasContent = false;
          if (body instanceof FormData) {
            // Check if FormData has any entries
            body.forEach(() => {
              hasContent = true;
            });
          } else if (typeof body === "string" && body.length > 0) {
            hasContent = true;
          }

          if (hasContent) {
            args = await decodeReply(body, { temporaryReferences });
          }
        } catch (error) {
          throw new Error(`Failed to decode action arguments: ${error}`);
        }

        // Execute the server action
        let returnValue: { ok: boolean; data: unknown };
        let actionStatus = 200;

        try {
          const action = await loadServerAction(actionId);
          const data = await action.apply(null, args);
          returnValue = { ok: true, data };
        } catch (error) {
          returnValue = { ok: false, data: error };
          actionStatus = 500;

          // Try to render error boundary
          const errorResult = await router.matchError(request, env, error, "route");

          if (errorResult) {
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
                isError: true,
              },
              returnValue,
            };

            const rscStream = renderToReadableStream<RscPayload>(payload, {
              temporaryReferences,
            });

            return new Response(rscStream, {
              status: actionStatus,
              headers: {
                "content-type": "text/x-component;charset=utf-8",
                "Server-Timing": `rendering;dur=${renderDuration.toFixed(2)}`,
              },
            });
          }
        }

        // Revalidate after action
        const actionName = actionId.includes("#")
          ? actionId.split("#").pop()!
          : actionId;

        const actionContext = {
          actionId: actionName,
          actionUrl: new URL(request.url),
          actionResult: returnValue.data,
          formData: actionFormData,
        };

        const matchResult = await router.matchPartial(request, env, actionContext);

        if (!matchResult) {
          // Fall back to full render
          const fullMatch = await router.match(request, env);
          const renderStart = performance.now();
          const root = renderSegments(fullMatch.segments);
          const renderDuration = performance.now() - renderStart;
          const serverTiming = fullMatch.serverTiming
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
            returnValue,
          };

          const rscStream = renderToReadableStream<RscPayload>(payload, {
            temporaryReferences,
          });

          const headers: Record<string, string> = {
            "content-type": "text/x-component;charset=utf-8",
          };
          if (serverTiming) {
            headers["Server-Timing"] = serverTiming;
          }

          return new Response(rscStream, {
            status: actionStatus,
            headers,
          });
        }

        // Return updated segments
        const renderStart = performance.now();
        renderSegments(matchResult.segments);
        const renderDuration = performance.now() - renderStart;
        const serverTiming = matchResult.serverTiming
          ? `${matchResult.serverTiming}, rendering;dur=${renderDuration.toFixed(2)}`
          : `rendering;dur=${renderDuration.toFixed(2)}`;

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
          returnValue,
        };

        const rscStream = renderToReadableStream<RscPayload>(payload, {
          temporaryReferences,
        });

        const actionHeaders: Record<string, string> = {
          "content-type": "text/x-component;charset=utf-8",
        };
        if (serverTiming) {
          actionHeaders["Server-Timing"] = serverTiming;
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
        const result = await router.matchPartial(request, env);

        if (!result) {
          // Fall back to full render
          const match = await router.match(request, env);
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
        const match = await router.match(request, env);
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
      }

      // Serialize to RSC stream
      const rscStream = renderToReadableStream<RscPayload>(payload);

      // Determine if this is an RSC request or HTML request
      const isRscRequest =
        (!request.headers.get("accept")?.includes("text/html") &&
          !url.searchParams.has("__html")) ||
        url.searchParams.has("__rsc");

      if (isRscRequest) {
        // Return RSC stream for client navigation
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

      // Delegate to SSR for HTML response
      const ssrModule = await loadSSRModule();
      const htmlStream = await ssrModule.renderHTML(rscStream);

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
      // Check if middleware/handler returned Response
      if (error instanceof Response) {
        return error;
      }

      console.error(`[RSC] Error:`, error);
      throw error;
    }
  };
}
