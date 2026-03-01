/**
 * Router Loader Resolution
 *
 * Loader execution, memoization, and error handling utilities.
 */

import type { ReactNode } from "react";
import { track } from "../server/context";
import type { EntryData } from "../server/context";
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
import { isHandle, type Handle } from "../handle.js";
import type { HandleStore } from "../server/handle-store.js";
import { getFetchableLoader } from "../server/fetchable-loader-store.js";
import { _getRequestContext } from "../server/request-context.js";
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
    const loaderCtx: LoaderContext<Record<string, string | undefined>, TEnv> = {
      params: ctx.params,
      request: ctx.request,
      searchParams: ctx.searchParams,
      search: (ctx as any).search,
      pathname: ctx.pathname,
      url: ctx.url,
      env: ctx.env,
      var: ctx.var,
      get: ctx.get,
      cookie(name: string) {
        return reqCtxRef?.cookie(name);
      },
      cookies() {
        return reqCtxRef?.cookies() ?? {};
      },
      use: <TDep, TDepParams = any>(
        dep: LoaderDefinition<TDep, TDepParams>,
      ): Promise<TDep> => {
        return useLoader(dep, currentLoaderId);
      },
      method: "GET",
      body: undefined,
      reverse: ctx.reverse as LoaderContext["reverse"],
    };

    const doneLoader = track(`loader:${loader.$$id}`);
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
  // Eagerly capture the HandleStore at setup time (before pipeline async ops).
  // In workerd/Cloudflare, dynamic imports and fetch() in the match pipeline
  // can disrupt AsyncLocalStorage, causing getRequestContext() to return
  // undefined when handlers later call ctx.use(handle). Capturing early
  // ensures the store reference survives ALS disruption.
  const handleStoreRef = _getRequestContext()?._handleStore;

  const useLoader = createLoaderExecutor(ctx, loaderPromises);

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

        const valueOrPromise =
          typeof dataOrFn === "function"
            ? (dataOrFn as () => Promise<unknown>)()
            : dataOrFn;

        store.push(handle.$$id, segmentId, valueOrPromise);
      };
    }

    return useLoader(item as LoaderDefinition<any, any>, null);
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
