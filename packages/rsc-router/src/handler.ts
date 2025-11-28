/**
 * rsc-router/handler
 *
 * Factory function to create RSC request handlers
 * Abstracts away the complexity of handling RSC streams, Server Actions, and SSR delegation
 */

import { renderSegments } from "./segment-system.js";
import type { RSCRouter } from "./router.js";
import type { ResolvedSegment } from "./types.js";

/**
 * RSC Payload type - sent to client
 * Contains the root component tree and metadata for client-side rendering
 */
export type RscPayload = {
  root: React.ReactNode;
  metadata?: {
    pathname: string;
    segments: ResolvedSegment[];
    isPartial?: boolean;
    matched?: string[];
    diff?: string[];
  };
  returnValue?: { ok: boolean; data: unknown };
};

/**
 * RSC runtime dependencies from @vitejs/plugin-rsc/rsc
 * These are provided by the RSC plugin and passed to the handler
 */
export interface RSCDependencies {
  renderToReadableStream: <T>(
    node: T,
    options?: { temporaryReferences?: unknown }
  ) => ReadableStream;
  decodeReply: (
    body: string | FormData,
    options?: { temporaryReferences?: unknown }
  ) => Promise<unknown[]>;
  createTemporaryReferenceSet: () => unknown;
  loadServerAction: (actionId: string) => Promise<(...args: unknown[]) => unknown>;
}

/**
 * SSR module interface - must export renderHTML function
 */
export interface SSRModule {
  renderHTML: (rscStream: ReadableStream) => Promise<ReadableStream>;
}

/**
 * Handler configuration options
 */
export interface HandlerConfig<TEnv = unknown> {
  /**
   * The RSC router instance
   */
  router: RSCRouter<TEnv>;

  /**
   * RSC runtime dependencies from @vitejs/plugin-rsc/rsc
   */
  rsc: RSCDependencies;

  /**
   * Async function to load the SSR module
   * This is called when HTML response is needed (not RSC stream)
   */
  loadSSR: () => Promise<SSRModule>;
}

/**
 * Create an RSC request handler
 *
 * @example
 * ```typescript
 * import { createHandler } from "rsc-router/handler";
 * import * as rsc from "@vitejs/plugin-rsc/rsc";
 * import { router } from "./router";
 *
 * export default createHandler({
 *   router,
 *   rsc,
 *   loadSSR: () => import.meta.viteRsc.loadModule("ssr", "index"),
 * });
 * ```
 */
export function createHandler<TEnv = unknown>(
  config: HandlerConfig<TEnv>
): (request: Request, env?: TEnv) => Promise<Response> {
  const { router, rsc, loadSSR } = config;
  const {
    renderToReadableStream,
    decodeReply,
    createTemporaryReferenceSet,
    loadServerAction,
  } = rsc;

  return async function handler(request: Request, env?: TEnv): Promise<Response> {
    const url = new URL(request.url);
    const isPartial = url.searchParams.has("_rsc_partial");
    const isAction =
      request.headers.has("rsc-action") || url.searchParams.has("_rsc_action");
    const actionId =
      request.headers.get("rsc-action") || url.searchParams.get("_rsc_action");

    let payload: RscPayload;

    try {
      // Server Action handling
      if (isAction && actionId) {
        const temporaryReferences = createTemporaryReferenceSet();

        // Decode action arguments
        const contentType = request.headers.get("content-type") || "";
        let args: unknown[] = [];
        let actionFormData: FormData | undefined;

        const body = contentType.includes("multipart/form-data")
          ? await request.formData()
          : await request.text();

        if (body instanceof FormData) {
          actionFormData = body;
        }

        if (
          (body instanceof FormData && body.entries().next().done === false) ||
          (typeof body === "string" && body.length > 0)
        ) {
          args = await decodeReply(body, { temporaryReferences });
        }

        // Execute server action
        let returnValue: { ok: boolean; data: unknown };
        let actionStatus = 200;

        try {
          const action = await loadServerAction(actionId);
          const data = await action.apply(null, args);
          returnValue = { ok: true, data };
        } catch (error) {
          returnValue = { ok: false, data: error };
          actionStatus = 500;
        }

        // Revalidate after action
        const actionContext = {
          actionId,
          actionUrl: new URL(request.url),
          actionResult: returnValue.data,
          formData: actionFormData,
        };

        const matchResult = await router.matchPartial(request, env ?? ({} as TEnv), actionContext);

        if (!matchResult) {
          // Fall back to full render
          const fullMatch = await router.match(request, env ?? ({} as TEnv));
          const root = renderSegments(fullMatch.segments);

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

          return new Response(rscStream, {
            status: actionStatus,
            headers: { "content-type": "text/x-component;charset=utf-8" },
          });
        }

        // Return partial update
        payload = {
          root: null,
          metadata: {
            pathname: url.pathname,
            segments: matchResult.segments,
            isPartial: true,
            matched: matchResult.matched,
            diff: matchResult.diff,
          },
          returnValue,
        };

        const rscStream = renderToReadableStream<RscPayload>(payload, {
          temporaryReferences,
        });

        return new Response(rscStream, {
          status: actionStatus,
          headers: { "content-type": "text/x-component;charset=utf-8" },
        });
      }

      // Navigation handling (GET requests)
      if (isPartial) {
        // Partial render for client-side navigation
        const result = await router.matchPartial(request, env ?? ({} as TEnv));

        if (!result) {
          // Fall back to full render
          const match = await router.match(request, env ?? ({} as TEnv));
          const root = renderSegments(match.segments);

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
          payload = {
            root: null,
            metadata: {
              pathname: url.pathname,
              segments: result.segments,
              matched: result.matched,
              diff: result.diff,
              isPartial: true,
            },
          };
        }
      } else {
        // Full render for initial page load
        const match = await router.match(request, env ?? ({} as TEnv));
        const root = renderSegments(match.segments);

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

      // Check if RSC or HTML request
      const isRscRequest =
        (!request.headers.get("accept")?.includes("text/html") &&
          !url.searchParams.has("__html")) ||
        url.searchParams.has("__rsc");

      if (isRscRequest) {
        // Return RSC stream for client navigation
        return new Response(rscStream, {
          headers: {
            "content-type": "text/x-component;charset=utf-8",
            vary: "accept",
          },
        });
      }

      // Delegate to SSR for HTML response
      const ssrModule = await loadSSR();
      const htmlStream = await ssrModule.renderHTML(rscStream);

      return new Response(htmlStream, {
        headers: { "content-type": "text/html;charset=utf-8" },
      });
    } catch (error) {
      // Handle middleware/handler Response short-circuit
      if (error instanceof Response) {
        return error;
      }

      console.error(`[RSC Handler] Error:`, error);
      throw error;
    }
  };
}
