/**
 * Router Loader Resolution
 *
 * Loader execution, memoization, and error handling utilities.
 */

import type { ReactNode } from "react";
import { track } from "../server/context";
import type { EntryData } from "../server/context";
import { contextGet } from "../context-var.js";
import type {
  ResolvedSegment,
  HandlerContext,
  InternalHandlerContext,
  LoaderDefinition,
  LoaderContext,
  LoaderDataResult,
  ErrorBoundaryHandler,
  ErrorBoundaryFallbackProps,
  ErrorInfo,
} from "../types";
import type { LoaderRevalidationResult, ActionContext } from "./types";
import { isHandle, collectHandleData, type Handle } from "../handle.js";
import { buildHandleSnapshot } from "../server/handle-store.js";
import { getFetchableLoader } from "../server/fetchable-loader-store.js";
import { _getRequestContext } from "../server/request-context.js";
import { isInsideLoaderScope } from "../server/context.js";
import { debugLog } from "./logging.js";

/**
 * Internal callback signature for loader error notifications.
 * This is a simplified callback for internal use in wrapLoaderWithErrorHandling.
 * The caller (wrapLoaderPromise in router.ts) bridges this to the full OnErrorCallback.
 */
export type LoaderErrorCallback = (
  error: unknown,
  context: {
    segmentId: string;
    loaderName: string;
    handledByBoundary: boolean;
  },
) => void;

/**
 * Wrap a loader promise with error handling for deferred client-side resolution.
 * Catches errors and converts them to LoaderDataResult objects that include
 * error info and pre-rendered fallback UI when an error boundary is available.
 *
 * @param onError - Optional callback invoked when loader errors occur.
 *   This has a simplified signature for internal use - the caller (typically
 *   wrapLoaderPromise in router.ts) is responsible for bridging to the full
 *   OnErrorCallback with complete request context (request, url, env, etc.).
 */
export function wrapLoaderWithErrorHandling<T>(
  promise: Promise<T>,
  entry: EntryData,
  segmentId: string,
  pathname: string,
  findNearestErrorBoundary: (
    entry: EntryData | null,
  ) => ReactNode | ErrorBoundaryHandler | null,
  createErrorInfo: (
    error: unknown,
    segmentId: string,
    segmentType: ErrorInfo["segmentType"],
  ) => ErrorInfo,
  onError?: LoaderErrorCallback,
): Promise<LoaderDataResult<T>> {
  // Extract loader name from segmentId (format: "M1L0D0.loaderName")
  const loaderName = segmentId.split(".").pop() || "unknown";

  return Promise.resolve(promise)
    .then(
      (data): LoaderDataResult<T> => ({
        __loaderResult: true,
        ok: true,
        data,
      }),
    )
    .catch((error): LoaderDataResult<T> => {
      // Find nearest error boundary
      const fallback = findNearestErrorBoundary(entry);

      // Create error info
      const errorInfo = createErrorInfo(error, segmentId, "loader");

      // Invoke onError callback if provided
      onError?.(error, {
        segmentId,
        loaderName,
        handledByBoundary: !!fallback,
      });

      if (!fallback) {
        // No error boundary - return error result without fallback
        // Client will throw this error
        return {
          __loaderResult: true,
          ok: false,
          error: errorInfo,
          fallback: null,
        };
      }

      // Render fallback on server
      let renderedFallback: ReactNode;
      if (typeof fallback === "function") {
        // ErrorBoundaryHandler - call with error info
        const props: ErrorBoundaryFallbackProps = {
          error: errorInfo,
        };
        renderedFallback = fallback(props);
      } else {
        renderedFallback = fallback;
      }

      debugLog("loader", "loader error wrapped with boundary fallback", {
        segmentId,
        message: errorInfo.message,
      });

      return {
        __loaderResult: true,
        ok: false,
        error: errorInfo,
        fallback: renderedFallback,
      };
    });
}

/**
 * Detect cycles in the loader dependency graph using DFS from a given node.
 * Returns the cycle path (array of loader IDs forming the cycle) if one exists,
 * or null if no cycle is found.
 */
function detectLoaderCycle(
  from: string,
  to: string,
  dependsOn: Map<string, Set<string>>,
): string[] | null {
  // If `to` can reach `from` via the dependency graph, adding the edge
  // from -> to creates a cycle. We search from `to` looking for `from`.
  const visited = new Set<string>();
  const path: string[] = [from, to];

  function dfs(current: string): string[] | null {
    if (current === from) {
      // Found a cycle: return the path leading back to `from`
      return path;
    }
    if (visited.has(current)) return null;
    visited.add(current);

    const deps = dependsOn.get(current);
    if (!deps) return null;

    for (const dep of deps) {
      path.push(dep);
      const cycle = dfs(dep);
      if (cycle) return cycle;
      path.pop();
    }
    return null;
  }

  return dfs(to);
}

/**
 * Creates a memoizing loader executor with cycle detection.
 * Shared by setupLoaderAccess and setupLoaderAccessSilent; only the handle
 * branch differs between the two, so only the loader logic is extracted here.
 *
 * Returns a useLoader(loader, callerLoaderId) function that:
 * - Tracks dependency edges between loaders for cycle detection
 * - Throws immediately (synchronously inside an async fn) on circular deps
 * - Memoizes each loader's promise so it runs at most once per request
 */
function createLoaderExecutor<TEnv>(
  ctx: HandlerContext<any, TEnv>,
  loaderPromises: Map<string, Promise<any>>,
): (
  loader: LoaderDefinition<any, any>,
  callerLoaderId: string | null,
) => Promise<any> {
  // Capture RequestContext eagerly for cookie access (ALS protection on Cloudflare)
  const reqCtxRef = _getRequestContext();

  // Dependency graph: loaderId -> set of loader IDs it directly depends on.
  const dependsOn = new Map<string, Set<string>>();

  // Loaders whose promises have not yet settled.
  // A dependency on a pending loader that closes a cycle means deadlock.
  const pendingLoaders = new Set<string>();

  function useLoader(
    loader: LoaderDefinition<any, any>,
    callerLoaderId: string | null,
  ): Promise<any> {
    // Record the dependency edge and check for cycles before running
    if (callerLoaderId !== null) {
      let deps = dependsOn.get(callerLoaderId);
      if (!deps) {
        deps = new Set();
        dependsOn.set(callerLoaderId, deps);
      }

      // Only relevant when the target is still pending (would deadlock)
      if (pendingLoaders.has(loader.$$id)) {
        const cycle = detectLoaderCycle(callerLoaderId, loader.$$id, dependsOn);
        if (cycle) {
          throw new Error(
            `Circular loader dependency detected: ${cycle.join(" -> ")}. ` +
              `Loaders cannot depend on each other in a cycle. ` +
              `Refactor to break the circular dependency.`,
          );
        }
      }

      deps.add(loader.$$id);
    }

    // Return cached promise if already started
    if (loaderPromises.has(loader.$$id)) {
      return loaderPromises.get(loader.$$id)!;
    }

    // Get loader function - either from loader object or fetchable registry
    let loaderFn = loader.fn;
    if (!loaderFn) {
      const fetchable = getFetchableLoader(loader.$$id);
      if (fetchable) {
        loaderFn = fetchable.fn;
      }
    }

    if (!loaderFn) {
      throw new Error(
        `Loader "${loader.$$id}" has no function. This usually means the loader was defined without "use server" and the function was not included in the build.`,
      );
    }

    pendingLoaders.add(loader.$$id);

    const currentLoaderId = loader.$$id;
    const variables = (ctx as InternalHandlerContext<any, TEnv>)._variables;

    // Capture whether this loader is being started from a DSL loader scope
    // (runInsideLoaderScope in fresh.ts). Handler-invoked loaders are NOT
    // inside loader scope. This determines whether rendered() is allowed.
    const isDslLoader = isInsideLoaderScope();

    let renderedResolved = false;
    let renderedPromise: Promise<void> | null = null;

    // Loader functions are always fresh (never cached), so they get an
    // unguarded get that bypasses non-cacheable read guards. This applies
    // to ALL loaders — DSL and handler-called — because the loader
    // function itself always re-executes. Also handles nested deps
    // (loaderA → use(loaderB)) since all share this unguarded get.
    const loaderCtx: LoaderContext<Record<string, string | undefined>, TEnv> = {
      params: ctx.params,
      routeParams: (ctx.params ?? {}) as Record<string, string>,
      request: ctx.request,
      searchParams: ctx.searchParams,
      search: (ctx as any).search,
      pathname: ctx.pathname,
      url: ctx.url,
      originalUrl: ctx.originalUrl,
      env: ctx.env,
      waitUntil: ctx.waitUntil.bind(ctx),
      executionContext: ctx.executionContext,
      get: ((keyOrVar: any) =>
        contextGet(variables, keyOrVar)) as typeof ctx.get,
      use: ((item: LoaderDefinition<any, any> | Handle<any, any>) => {
        if (isHandle(item)) {
          if (!renderedResolved) {
            throw new Error(
              `ctx.use(handle) in a loader requires "await ctx.rendered()" first. ` +
                `Handle "${item.$$id}" cannot be read until the render tree has settled.`,
            );
          }
          const reqCtx = reqCtxRef ?? _getRequestContext();
          if (!reqCtx) {
            throw new Error(
              `ctx.use(handle) failed: request context not available.`,
            );
          }
          const segmentOrder = reqCtx._renderBarrierSegmentOrder ?? [];
          const snapshot =
            reqCtx._renderBarrierHandleSnapshot ??
            buildHandleSnapshot(reqCtx._handleStore, segmentOrder);
          return collectHandleData(item, snapshot, segmentOrder);
        }

        // Loader case
        return useLoader(item as LoaderDefinition<any, any>, currentLoaderId);
      }) as LoaderContext["use"],
      method: "GET",
      body: undefined,
      reverse: ctx.reverse as LoaderContext["reverse"],
      rendered: (): Promise<void> => {
        // Guard: only DSL loaders may use rendered()
        if (!isDslLoader) {
          throw new Error(
            `ctx.rendered() is only available in DSL loaders (registered via loader() in urls()). ` +
              `Handler-invoked loaders (ctx.use(Loader) inside a handler) cannot use rendered().`,
          );
        }

        // Guard: reject streaming trees
        const reqCtx = reqCtxRef ?? _getRequestContext();
        if (reqCtx?._treeHasStreaming) {
          throw new Error(
            `ctx.rendered() is not supported when the matched route tree uses loading(). ` +
              `Streaming handlers may not have settled when rendered() resolves. ` +
              `Remove loading() from the route tree or restructure to avoid rendered().`,
          );
        }

        if (renderedPromise) return renderedPromise;

        if (!reqCtx) {
          throw new Error(
            `ctx.rendered() failed: request context not available.`,
          );
        }

        // Bidirectional deadlock check: if a handler already started
        // awaiting this loader, calling rendered() would deadlock.
        if (reqCtx._handlerLoaderDeps?.has(currentLoaderId)) {
          throw new Error(
            `Deadlock: loader "${currentLoaderId}" called ctx.rendered() but a handler ` +
              `is already awaiting this loader via ctx.use(). The handler blocks ` +
              `segment resolution, which blocks the barrier, which blocks this loader. ` +
              `Move the data dependency to a loader-to-loader pattern instead.`,
          );
        }

        // Register this loader as waiting for the barrier so that
        // setupLoaderAccess can detect deadlocks when a handler
        // tries to await the same loader via ctx.use().
        if (!reqCtx._renderBarrierWaiters) {
          reqCtx._renderBarrierWaiters = new Set();
        }
        reqCtx._renderBarrierWaiters.add(currentLoaderId);

        renderedPromise = reqCtx._renderBarrier.then(() => {
          renderedResolved = true;
        });
        return renderedPromise;
      },
    };

    const doneLoader = track(`loader:${loader.$$id}`, 2);
    const promise = Promise.resolve(
      loaderFn(loaderCtx as LoaderContext<any, TEnv>),
    ).finally(() => {
      pendingLoaders.delete(loader.$$id);
      doneLoader();
    });

    loaderPromises.set(loader.$$id, promise);
    return promise;
  }

  return useLoader;
}

/**
 * Set up the use() method on handler context to access loaders and handles.
 *
 * For loaders: Lazily runs loaders, memoizes results per request.
 * For handles: Returns a push function bound to the current segment.
 *
 * Includes cycle detection: tracks dependency edges between loaders and
 * throws on circular dependencies to prevent deadlocks.
 */
export function setupLoaderAccess<TEnv>(
  ctx: HandlerContext<any, TEnv>,
  loaderPromises: Map<string, Promise<any>>,
): void {
  // Eagerly capture the request context and HandleStore at setup time
  // (before pipeline async ops). In workerd/Cloudflare, dynamic imports and
  // fetch() in the match pipeline can disrupt AsyncLocalStorage, causing
  // getRequestContext() to return undefined when handlers later call
  // ctx.use(handle). Capturing early ensures references survive ALS disruption.
  const reqCtxRef = _getRequestContext();
  const handleStoreRef = reqCtxRef?._handleStore;

  const useLoader = createLoaderExecutor(ctx, loaderPromises);

  // Track whether we're inside a handle push callback. Loaders started
  // from push callbacks (e.g. push(async () => ctx.use(Loader))) do NOT
  // block segment resolution, so they must not be registered as handler
  // dependencies for deadlock detection.
  let insideHandlePush = false;

  ctx.use = ((item: LoaderDefinition<any, any> | Handle<any, any>) => {
    if (isHandle(item)) {
      const handle = item;
      const store = handleStoreRef;
      const segmentId = (ctx as InternalHandlerContext<any, TEnv>)
        ._currentSegmentId;

      if (!segmentId) {
        throw new Error(
          `Handle "${handle.$$id}" used outside of handler context. ` +
            `Handles must be used within route/layout handlers.`,
        );
      }

      return (
        dataOrFn: unknown | Promise<unknown> | (() => Promise<unknown>),
      ) => {
        if (!store) return;

        if (typeof dataOrFn === "function") {
          // Mark scope so ctx.use(loader) calls inside the callback
          // are not registered as handler-to-loader deps.
          insideHandlePush = true;
          try {
            const result = (dataOrFn as () => Promise<unknown>)();
            store.push(handle.$$id, segmentId, result);
          } finally {
            insideHandlePush = false;
          }
          return;
        }

        store.push(handle.$$id, segmentId, dataOrFn);
      };
    }

    // Deadlock guard and handler-to-loader dependency tracking.
    // Skip when inside a DSL loader scope (resolveLoaderData also calls
    // ctx.use() but that's DSL-to-DSL, not handler-to-loader) or when
    // inside a handle push callback (push callbacks don't block segment
    // resolution so they can't cause rendered() deadlocks).
    const loader = item as LoaderDefinition<any, any>;
    if (!isInsideLoaderScope() && !insideHandlePush) {
      const reqCtx = reqCtxRef ?? _getRequestContext();
      if (reqCtx) {
        // Direction 1: handler awaits loader that already called rendered()
        if (
          loaderPromises.has(loader.$$id) &&
          reqCtx._renderBarrierWaiters?.has(loader.$$id)
        ) {
          throw new Error(
            `Deadlock: handler is awaiting loader "${loader.$$id}" which called ctx.rendered(). ` +
              `The loader is waiting for segment resolution, but the handler blocks resolution. ` +
              `Move the data dependency to a loader-to-loader pattern instead.`,
          );
        }
        // Direction 2: track dep so rendered() can detect the deadlock
        // if the loader calls it later. Skip when the barrier has already
        // resolved — no deadlock is possible (rendered() resolves immediately).
        // _renderBarrierSegmentOrder is undefined before resolution, string[]
        // after. This also prevents false positives from handle push callbacks
        // that resume after their first await (post-barrier-resolution).
        if (reqCtx._renderBarrierSegmentOrder === undefined) {
          if (!reqCtx._handlerLoaderDeps) reqCtx._handlerLoaderDeps = new Set();
          reqCtx._handlerLoaderDeps.add(loader.$$id);
        }
      }
    }

    return useLoader(loader, null);
  }) as typeof ctx.use;
}

/**
 * Set up ctx.use() for pre-rendering (build-time).
 * Handles push to HandleStore; loaders throw with a clear error.
 */
export function setupBuildUse<TEnv>(ctx: HandlerContext<any, TEnv>): void {
  // Eagerly capture the HandleStore (same ALS protection as setupLoaderAccess).
  const handleStoreRef = _getRequestContext()?._handleStore;

  ctx.use = ((item: LoaderDefinition<any, any> | Handle<any, any>) => {
    // Handle case: return a push function bound to the current segment
    if (isHandle(item)) {
      const handle = item;
      const store = handleStoreRef;
      const segmentId = (ctx as InternalHandlerContext<any, TEnv>)
        ._currentSegmentId;

      if (!segmentId) {
        throw new Error(
          `Handle "${handle.$$id}" used outside of handler context. ` +
            `Handles must be used within route/layout handlers.`,
        );
      }

      return (
        dataOrFn: unknown | Promise<unknown> | (() => Promise<unknown>),
      ) => {
        if (!store) return;

        const valueOrPromise =
          typeof dataOrFn === "function"
            ? (dataOrFn as () => Promise<unknown>)()
            : dataOrFn;

        store.push(handle.$$id, segmentId, valueOrPromise);
      };
    }

    // Loader case: not available during pre-rendering
    throw new Error(
      "Loaders are not available during pre-rendering. " +
        "Use them on parent layouts with cache() for request-time data, " +
        "or use a passthrough prerender handler.",
    );
  }) as typeof ctx.use;
}

/**
 * Set up ctx.use() for proactive caching (silent mode).
 * Handles are silently ignored (no push to HandleStore).
 * Loaders work normally but with fresh memoization and cycle detection.
 *
 * This prevents duplicate handle data (breadcrumbs, meta) from being
 * pushed to the response stream during background proactive caching.
 */
export function setupLoaderAccessSilent<TEnv>(
  ctx: HandlerContext<any, TEnv>,
  loaderPromises: Map<string, Promise<any>>,
): void {
  const useLoader = createLoaderExecutor(ctx, loaderPromises);

  ctx.use = ((item: LoaderDefinition<any, any> | Handle<any, any>) => {
    if (isHandle(item)) {
      // Silent mode - return a no-op so handle data is not pushed during caching
      return (_dataOrFn: unknown) => {};
    }

    return useLoader(item as LoaderDefinition<any, any>, null);
  }) as typeof ctx.use;
}

/**
 * Conditional execution based on revalidation
 * Evaluates revalidation logic lazily, then executes appropriate callback
 *
 * @param shouldRevalidate - Async function that determines if revalidation is needed
 * @param onRevalidate - Callback executed if revalidation returns true
 * @param onSkip - Callback executed if revalidation returns false
 * @returns Result from either onRevalidate or onSkip
 */
export async function revalidate<T>(
  shouldRevalidate: () => Promise<boolean>,
  onRevalidate: () => Promise<T>,
  onSkip: () => T,
): Promise<T> {
  const needsRevalidation = await shouldRevalidate();
  return needsRevalidation ? await onRevalidate() : onSkip();
}
