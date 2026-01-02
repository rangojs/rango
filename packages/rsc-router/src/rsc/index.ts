/// <reference types="@vitejs/plugin-rsc/types" />
import { renderSegments } from "../segment-system.js";
import type { RSCRouter } from "../router.js";
import type { ResolvedSegment, SlotState, RouterInternalContext } from "../types.js";
import { createHandleStore, type HandleStore, type HandleData } from "../server/handle-store.js";
import { RouteNotFoundError } from "../errors.js";
import * as rscDeps from "@vitejs/plugin-rsc/rsc";


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
    /** Root layout component for browser-side re-renders (client component reference) */
    rootLayout?: React.ComponentType<{ children: React.ReactNode }>;
    /** Handle data accumulated across route segments (async generator that yields on each push) */
    handles?: AsyncGenerator<HandleData, void, unknown>;
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
 * Options for SSR HTML rendering
 */
export interface SSRRenderOptions {
  /**
   * Nonce for Content Security Policy (CSP)
   */
  nonce?: string;
}

/**
 * SSR module interface for HTML rendering
 */
export interface SSRModule {
  renderHTML: (rscStream: ReadableStream<Uint8Array>, options?: SSRRenderOptions) => Promise<ReadableStream<Uint8Array>>;
}

/**
 * Function to load SSR module dynamically
 */
export type LoadSSRModule = () => Promise<SSRModule>;

/**
 * Nonce provider function type.
 * Can return a nonce string, or true to auto-generate one.
 */
export type NonceProvider<TEnv = unknown> = (
  request: Request,
  env: TEnv
) => string | true | Promise<string | true>;

/**
 * Options for creating an RSC handler
 */
export interface CreateRSCHandlerOptions<TEnv = unknown> {
  /**
   * The RSC router instance
   */
  router: RSCRouter<TEnv>;

  /**
   * RSC dependencies from @vitejs/plugin-rsc/rsc.
   * Defaults to the exports from @vitejs/plugin-rsc/rsc.
   */
  deps?: RSCDependencies;

  /**
   * Function to load the SSR module for HTML rendering.
   * Defaults to: () => import.meta.viteRsc.loadModule("ssr", "index")
   */
  loadSSRModule?: LoadSSRModule;

  /**
   * Nonce provider for Content Security Policy (CSP).
   *
   * Can be:
   * - A function that returns a nonce string
   * - A function that returns `true` to auto-generate a nonce
   * - Undefined to disable nonce (default)
   *
   * The nonce will be applied to inline scripts injected by the RSC payload.
   *
   * @example Auto-generate nonce
   * ```tsx
   * createRSCHandler({
   *   router,
   *   nonce: () => true,
   * });
   * ```
   *
   * @example Custom nonce from request context
   * ```tsx
   * createRSCHandler({
   *   router,
   *   nonce: (request, env) => env.nonce,
   * });
   * ```
   */
  nonce?: NonceProvider<TEnv>;
}

/**
 * Create an RSC request handler.
 *
 * @example Basic usage (deps and loadSSRModule have sensible defaults)
 * ```tsx
 * import { createRSCHandler } from "rsc-router/rsc";
 * import { router } from "./router.js";
 *
 * export default createRSCHandler({ router });
 * ```
 *
 * @example With custom deps (advanced)
 * ```tsx
 * import { createRSCHandler } from "rsc-router/rsc";
 * import * as rsc from "@vitejs/plugin-rsc/rsc";
 * import { router } from "./router.js";
 *
 * export default createRSCHandler({
 *   router,
 *   deps: rsc,
 *   loadSSRModule: () => import.meta.viteRsc.loadModule("ssr", "index"),
 * });
 * ```
 */
/**
 * Generate a cryptographic nonce for CSP
 */
function generateNonce(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  // Convert to base64
  let binary = "";
  for (let i = 0; i < array.length; i++) {
    binary += String.fromCharCode(array[i]);
  }
  return btoa(binary);
}

export function createRSCHandler<TEnv = unknown>(
  options: CreateRSCHandlerOptions<TEnv>
) {
  const { router, nonce: nonceProvider } = options;

  // Use provided deps or default to @vitejs/plugin-rsc/rsc exports
  const deps = options.deps ?? rscDeps;
  const {
    renderToReadableStream,
    decodeReply,
    createTemporaryReferenceSet,
    loadServerAction,
  } = deps;

  // Use provided loadSSRModule or default to vite RSC module loader
  const loadSSRModule =
    options.loadSSRModule ??
    (() => import.meta.viteRsc.loadModule("ssr", "index"));

  return async function handler(
    request: Request,
    env: TEnv = {} as TEnv
  ): Promise<Response> {
    // Resolve nonce if provider is set
    let nonce: string | undefined;
    if (nonceProvider) {
      const result = await nonceProvider(request, env);
      nonce = result === true ? generateNonce() : result;
    }
    const url = new URL(request.url);
    const isPartial = url.searchParams.has("_rsc_partial");
    const isAction =
      request.headers.has("rsc-action") || url.searchParams.has("_rsc_action");
    const actionId =
      request.headers.get("rsc-action") || url.searchParams.get("_rsc_action");

    // Create handle store for tracking pending handlers
    const handleStore = createHandleStore();

    // Attach handle store to env for router access
    const envWithHandleStore = {
      ...env,
      __handleStore: handleStore,
    } as TEnv & RouterInternalContext;

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
          const errorResult = await router.matchError(request, envWithHandleStore, error, "route");

          if (errorResult) {
            const renderStart = performance.now();
            const root = renderSegments(errorResult.segments, {
              rootLayout: router.rootLayout,
            });
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
                handles: handleStore.stream(),
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
        const actionContext = {
          actionId,
          actionUrl: new URL(request.url),
          actionResult: returnValue.data,
          formData: actionFormData,
        };

        const matchResult = await router.matchPartial(request, envWithHandleStore, actionContext);

        if (!matchResult) {
          // Fall back to full render
          const fullMatch = await router.match(request, envWithHandleStore);

          // Handle trailing slash redirect
          if (fullMatch.redirect) {
            return new Response(null, {
              status: 308,
              headers: {
                Location: fullMatch.redirect,
              },
            });
          }

          const renderStart = performance.now();
          const root = renderSegments(fullMatch.segments, {
            rootLayout: router.rootLayout,
          });
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
              handles: handleStore.stream(),
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
        renderSegments(matchResult.segments, {
          rootLayout: router.rootLayout,
        });
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
            handles: handleStore.stream(),
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
        const result = await router.matchPartial(request, envWithHandleStore);

        if (!result) {
          // Fall back to full render
          const match = await router.match(request, envWithHandleStore);

          // Handle trailing slash redirect
          if (match.redirect) {
            return new Response(null, {
              status: 308,
              headers: {
                Location: match.redirect,
              },
            });
          }

          const renderStart = performance.now();
          const root = renderSegments(match.segments, {
            rootLayout: router.rootLayout,
          });
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
              handles: handleStore.stream(),
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
              handles: handleStore.stream(),
            },
          };
        }
      } else {
        // Full render (initial page load)
        const match = await router.match(request, envWithHandleStore);

        // Handle trailing slash redirect
        if (match.redirect) {
          return new Response(null, {
            status: 308,
            headers: {
              Location: match.redirect,
            },
          });
        }

        const renderStart = performance.now();
        const root = renderSegments(match.segments, {
          rootLayout: router.rootLayout,
        });
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
            // Send rootLayout for browser-side re-renders
            rootLayout: router.rootLayout,
            handles: handleStore.stream(),
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
      const htmlStream = await ssrModule.renderHTML(rscStream, { nonce });

      const htmlHeaders: Record<string, string> = {
        "content-type": "text/html;charset=utf-8",
      };
      if (serverTiming) {
        htmlHeaders["Server-Timing"] = serverTiming;
      }
      // Expose nonce in response header for CSP header construction
      if (nonce) {
        htmlHeaders["x-nonce"] = nonce;
      }

      return new Response(htmlStream, {
        headers: htmlHeaders,
      });
    } catch (error) {
      // Check if middleware/handler returned Response
      if (error instanceof Response) {
        return error;
      }

      // Return 404 for unmatched routes instead of 500
      if (error instanceof RouteNotFoundError) {
        return new Response("Not Found", { status: 404 });
      }

      console.error(`[RSC] Error:`, error);
      throw error;
    }
  };
}

// Re-export HandleStore types for consumers who need custom handling
export {
  createHandleStore,
  type HandleStore,
  type HandleData,
} from "../server/handle-store.js";
