/// <reference types="@vitejs/plugin-rsc/types" />
import { renderSegments } from "../segment-system.js";
import type { RSCRouter } from "../router.js";
import type { ResolvedSegment, SlotState, RouterInternalContext, LoaderActionContext } from "../types.js";
import { createHandleStore, type HandleStore, type HandleData } from "../server/handle-store.js";
import { RouteNotFoundError } from "../errors.js";
import { getLoaderLazy } from "../server/loader-registry.js";
import {
  matchMiddleware,
  executeAppMiddleware,
  executeLoaderAppMiddleware,
  type AppMiddlewareEntry,
} from "../router/app-middleware.js";
import { runWithRequestContext, setRequestContextParams } from "../server/request-context.js";
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
   * RSC dependencies from @vitejs/plugin-rsc/rsc.
   * Defaults to the exports from @vitejs/plugin-rsc/rsc.
   */
  deps?: RSCDependencies;

  /**
   * Function to load the SSR module for HTML rendering.
   * Defaults to: () => import.meta.viteRsc.loadModule("ssr", "index")
   */
  loadSSRModule?: LoadSSRModule;
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
export function createRSCHandler<TEnv = unknown>(
  options: CreateRSCHandlerOptions<TEnv>
) {
  const { router } = options;

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
    const url = new URL(request.url);

    // Match app-level middleware
    const matchedMiddleware = matchMiddleware(url.pathname, router.appMiddleware);

    // Shared variables between middleware and route handlers
    const variables: Record<string, any> = {};

    // Build request context matching HandlerContext shape
    // params starts empty, populated after route matching via setRequestContextParams
    const requestContext = {
      env,
      request,
      url,
      pathname: url.pathname,
      searchParams: url.searchParams,
      var: variables,
      get: <K extends string>(key: K) => variables[key],
      set: <K extends string>(key: K, value: any) => { variables[key] = value; },
      params: {} as Record<string, string>,
    };

    // Wrap entire request handling in request context
    // Makes context available via getRequestContext() throughout:
    // - Middleware execution
    // - Route handlers and loaders
    // - Server components during rendering
    // - Error boundaries
    // - Streaming
    return runWithRequestContext(requestContext, async () => {
      // Core handler logic (wrapped by middleware)
      const coreHandler = async (): Promise<Response> => {
        return coreRequestHandler(request, env, url, variables);
      };

      // Execute middleware chain if any, otherwise call core handler directly
      if (matchedMiddleware.length > 0) {
        return executeAppMiddleware(
          matchedMiddleware,
          request,
          env,
          variables,
          coreHandler
        );
      }

      return coreHandler();
    });
  };

  // Core request handling logic (separated for middleware wrapping)
  async function coreRequestHandler(
    request: Request,
    env: TEnv,
    url: URL,
    variables: Record<string, any>
  ): Promise<Response> {
    // First, check for route-level middleware
    const preview = await router.previewMatch(request, env);
    if (preview?.routeMiddleware && preview.routeMiddleware.length > 0) {
      // Convert route middleware to app middleware format for execution
      const middlewareEntries = preview.routeMiddleware.map((mw) => ({
        entry: {
          pattern: null,
          regex: null,
          paramNames: [],
          handler: mw.handler,
          mountPrefix: null,
        },
        params: mw.params,
      }));

      // Execute route middleware wrapping the actual request handling
      return executeAppMiddleware(
        middlewareEntries,
        request,
        env,
        variables,
        () => coreRequestHandlerInner(request, env, url, variables)
      );
    }

    // No route middleware, proceed directly
    return coreRequestHandlerInner(request, env, url, variables);
  }

  // Inner request handler (actual RSC logic, wrapped by route middleware if any)
  async function coreRequestHandlerInner(
    request: Request,
    env: TEnv,
    url: URL,
    variables: Record<string, any>
  ): Promise<Response> {
    const isPartial = url.searchParams.has("_rsc_partial");
    const isAction =
      request.headers.has("rsc-action") || url.searchParams.has("_rsc_action");
    const actionId =
      request.headers.get("rsc-action") || url.searchParams.get("_rsc_action");

    // Create handle store for tracking pending handlers
    const handleStore = createHandleStore();

    // Attach handle store and shared variables to env for router access
    const envWithHandleStore = {
      ...env,
      __handleStore: handleStore,
      __middlewareVariables: variables,
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

        // Track the action reference for extracting $id
        let loadedAction: Function | undefined;

        try {
          loadedAction = await loadServerAction(actionId);
          // Request context already available from handler wrapper (runWithRequestContext)
          const data = await loadedAction!.apply(null, args);
          returnValue = { ok: true, data };
        } catch (error) {
          returnValue = { ok: false, data: error };
          actionStatus = 500;

          // Try to render error boundary
          const errorResult = await router.matchError(request, envWithHandleStore, error, "route");

          if (errorResult) {
            // Update request context with matched params
            setRequestContextParams(errorResult.params);

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
        // Use the action's $id (file path) if available, otherwise fall back to $$id or request actionId (hash)
        // In production builds, $id contains the file path for server bundles, enabling
        // revalidation functions to match actions by their source file path
        // Note: We use $id (single dollar) instead of $$id because React's registerServerReference
        // sets $$id as a non-writable property
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

        const matchResult = await router.matchPartial(request, envWithHandleStore, actionContext);

        if (!matchResult) {
          // Fall back to full render
          const fullMatch = await router.match(request, envWithHandleStore);

          // Update request context with matched params
          setRequestContextParams(fullMatch.params);

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

        // Update request context with matched params
        setRequestContextParams(matchResult.params);

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
      // LOADER FETCH EXECUTION (data fetching with RSC serialization)
      // Supports GET (params in query string) and POST/PUT/PATCH/DELETE (JSON body)
      // ============================================================================
      const isLoaderRequest = url.searchParams.has("_rsc_loader");
      if (isLoaderRequest) {
        const loaderId = url.searchParams.get("_rsc_loader");

        if (!loaderId) {
          return new Response("Missing _rsc_loader parameter", {
            status: 400,
          });
        }

        // Look up loader lazily (imports on-demand if not already loaded)
        const registeredLoader = await getLoaderLazy(loaderId);
        if (!registeredLoader) {
          return new Response(`Loader "${loaderId}" not found in registry`, {
            status: 404,
          });
        }

        // Parse params and body based on request method
        let loaderParams: Record<string, string> = {};
        let loaderBody: unknown = undefined;
        const isBodyMethod = request.method !== "GET" && request.method !== "HEAD";

        if (isBodyMethod) {
          // POST/PUT/PATCH/DELETE - read from JSON body
          try {
            const contentType = request.headers.get("content-type") || "";
            if (contentType.includes("application/json")) {
              const jsonBody = await request.json() as { params?: Record<string, string>; body?: unknown };
              loaderParams = jsonBody.params ?? {};
              loaderBody = jsonBody.body;
            }
          } catch {
            return new Response("Invalid JSON body", {
              status: 400,
            });
          }
        } else {
          // GET - read from query string
          const loaderParamsJson = url.searchParams.get("_rsc_loader_params");
          if (loaderParamsJson) {
            try {
              loaderParams = JSON.parse(loaderParamsJson);
            } catch {
              return new Response("Invalid _rsc_loader_params JSON", {
                status: 400,
              });
            }
          }
        }

        // Execute the loader with onion-style middleware
        try {
          const { fn, middleware } = registeredLoader;

          // Execute middleware wrapping the loader execution
          // Middleware uses AppMiddlewareFn signature - same as route middleware
          // Variables are shared between app-level middleware, loader middleware, and loader function
          //
          // Build env with middleware variables so createHandlerContext can access them
          const envWithVariables = {
            ...env,
            __middlewareVariables: variables,
          };

          return await executeLoaderAppMiddleware(
            middleware,
            request,
            env,
            loaderParams,
            variables,
            async () => {
              // Use createHandlerContext to build proper context
              // This ensures consistency with route handlers and proper variable sharing
              const { createHandlerContext } = await import("../router/handler-context.js");
              const ctx = createHandlerContext(
                loaderParams,
                request,
                url.searchParams,
                url.pathname,
                url,
                envWithVariables
              );

              // Extend context with method and body for POST/PUT/PATCH/DELETE
              const extendedCtx: any = {
                ...ctx,
                method: request.method,
                body: loaderBody,
              };

              // Execute loader function
              const result = await fn(extendedCtx);

              // Serialize result with RSC
              interface LoaderPayload {
                loaderResult: unknown;
              }
              const loaderPayload: LoaderPayload = { loaderResult: result };
              const rscStream = renderToReadableStream<LoaderPayload>(loaderPayload);

              return new Response(rscStream, {
                headers: {
                  "content-type": "text/x-component;charset=utf-8",
                  // Allow browser/CDN caching for GET requests
                  "cache-control": "public, max-age=0, must-revalidate",
                },
              });
            }
          );
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          const isDev = process.env.NODE_ENV !== "production";

          // Always log full error details on server
          console.error("[RSC] Loader error:", error);

          // Call onError callback if configured (for monitoring/alerting)
          if (router.onError) {
            try {
              router.onError(err, {
                source: "loader",
                pathname: url.pathname,
                loaderId,
              });
            } catch (callbackError) {
              console.error("[RSC] onError callback failed:", callbackError);
            }
          }

          // Sanitize error for client - only expose details in development
          const errorPayload = {
            loaderResult: null,
            loaderError: {
              message: isDev ? err.message : "An error occurred",
              name: err.name,
            },
          };
          const rscStream = renderToReadableStream(errorPayload);

          return new Response(rscStream, {
            status: 500,
            headers: {
              "content-type": "text/x-component;charset=utf-8",
            },
          });
        }
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

          // Update request context with matched params
          setRequestContextParams(match.params);

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
          // Update request context with matched params
          setRequestContextParams(result.params);

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

        // Update request context with matched params
        setRequestContextParams(match.params);

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

      // Return 404 for unmatched routes instead of 500
      if (error instanceof RouteNotFoundError) {
        return new Response("Not Found", { status: 404 });
      }

      console.error(`[RSC] Error:`, error);
      throw error;
    }
  }
}

// Re-export HandleStore types for consumers who need custom handling
export {
  createHandleStore,
  type HandleStore,
  type HandleData,
} from "../server/handle-store.js";
