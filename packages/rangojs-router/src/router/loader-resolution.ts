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
import { getRequestContext } from "../server/request-context.js";

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
  }
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
    entry: EntryData | null
  ) => ReactNode | ErrorBoundaryHandler | null,
  createErrorInfo: (
    error: unknown,
    segmentId: string,
    segmentType: ErrorInfo["segmentType"]
  ) => ErrorInfo,
  onError?: LoaderErrorCallback
): Promise<LoaderDataResult<T>> {
  // Extract loader name from segmentId (format: "M1L0D0.loaderName")
  const loaderName = segmentId.split(".").pop() || "unknown";

  return Promise.resolve(promise)
    .then(
      (data): LoaderDataResult<T> => ({
        __loaderResult: true,
        ok: true,
        data,
      })
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

      console.log(
        `[Router] Loader error wrapped with boundary fallback in ${segmentId}:`,
        errorInfo.message
      );

      return {
        __loaderResult: true,
        ok: false,
        error: errorInfo,
        fallback: renderedFallback,
      };
    });
}

/**
 * Set up the use() method on handler context to access loaders and handles.
 *
 * For loaders: Lazily runs loaders, memoizes results per request.
 * For handles: Returns a push function bound to the current segment.
 */
export function setupLoaderAccess<TEnv>(
  ctx: HandlerContext<any, TEnv>,
  loaderPromises: Map<string, Promise<any>>
): void {
  // Get HandleStore from request context
  const getHandleStore = (): HandleStore | undefined => {
    return getRequestContext()?._handleStore;
  };

  // The use() function handles both loaders and handles
  ctx.use = ((item: LoaderDefinition<any, any> | Handle<any, any>) => {
    // Handle case: return a push function
    if (isHandle(item)) {
      const handle = item;
      const store = getHandleStore();
      const segmentId = (ctx as InternalHandlerContext)._currentSegmentId;

      if (!segmentId) {
        throw new Error(
          `Handle "${handle.$$id}" used outside of handler context. ` +
            `Handles must be used within route/layout handlers.`
        );
      }

      // Return a push function bound to this handle and segment
      // Accepts: value, Promise, or async callback (executed immediately)
      // Promises are pushed directly - RSC will serialize and stream them
      return (dataOrFn: unknown | Promise<unknown> | (() => Promise<unknown>)) => {
        if (!store) return;

        // If it's a function, call it immediately to get the promise
        const valueOrPromise = typeof dataOrFn === "function"
          ? (dataOrFn as () => Promise<unknown>)()
          : dataOrFn;

        // Push directly - promises will be serialized by RSC and streamed
        store.push(handle.$$id, segmentId, valueOrPromise);
      };
    }

    // Loader case: existing behavior
    const loader = item as LoaderDefinition<any, any>;

    // Return cached promise if already started
    if (loaderPromises.has(loader.$$id)) {
      return loaderPromises.get(loader.$$id);
    }

    // Get loader function - either from loader object or fetchable registry
    // Fetchable loaders store fn in registry (not on object) to avoid client bundling issues
    let loaderFn = loader.fn;
    if (!loaderFn) {
      const fetchable = getFetchableLoader(loader.$$id);
      if (fetchable) {
        loaderFn = fetchable.fn;
      }
    }

    // Ensure loader has a function
    if (!loaderFn) {
      throw new Error(
        `Loader "${loader.$$id}" has no function. This usually means the loader was defined without "use server" and the function was not included in the build.`
      );
    }

    // Create loader context with recursive use() support
    const loaderCtx: LoaderContext<Record<string, string | undefined>, TEnv> = {
      params: ctx.params,
      request: ctx.request,
      searchParams: ctx.searchParams,
      pathname: ctx.pathname,
      url: ctx.url,
      env: ctx.env,
      var: ctx.var,
      get: ctx.get,
      use: <TDep, TDepParams = any>(
        dep: LoaderDefinition<TDep, TDepParams>
      ): Promise<TDep> => {
        // Recursive call - will start dep loader if not already started
        return ctx.use(dep);
      },
      // Default to GET for loaders called through route handlers
      method: "GET",
      body: undefined,
    };

    // Start loader execution with tracking
    const doneLoader = track(`loader:${loader.$$id}`);
    const promise = Promise.resolve(
      loaderFn(loaderCtx as LoaderContext<any, TEnv>)
    ).finally(() => {
      doneLoader();
    });

    // Memoize for subsequent calls
    loaderPromises.set(loader.$$id, promise);

    return promise;
  }) as typeof ctx.use;
}

/**
 * Set up ctx.use() for pre-rendering (build-time).
 * Handles push to HandleStore; loaders throw with a clear error.
 */
export function setupBuildUse<TEnv>(
  ctx: HandlerContext<any, TEnv>,
): void {
  // Get HandleStore from request context
  const getHandleStore = (): HandleStore | undefined => {
    return getRequestContext()?._handleStore;
  };

  ctx.use = ((item: LoaderDefinition<any, any> | Handle<any, any>) => {
    // Handle case: return a push function bound to the current segment
    if (isHandle(item)) {
      const handle = item;
      const store = getHandleStore();
      const segmentId = (ctx as InternalHandlerContext)._currentSegmentId;

      if (!segmentId) {
        throw new Error(
          `Handle "${handle.$$id}" used outside of handler context. ` +
            `Handles must be used within route/layout handlers.`,
        );
      }

      return (dataOrFn: unknown | Promise<unknown> | (() => Promise<unknown>)) => {
        if (!store) return;

        const valueOrPromise = typeof dataOrFn === "function"
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
 * Loaders work normally but with fresh memoization.
 *
 * This prevents duplicate handle data (breadcrumbs, meta) from being
 * pushed to the response stream during background proactive caching.
 */
export function setupLoaderAccessSilent<TEnv>(
  ctx: HandlerContext<any, TEnv>,
  loaderPromises: Map<string, Promise<any>>
): void {
  ctx.use = ((item: LoaderDefinition<any, any> | Handle<any, any>) => {
    // Handle case: return a no-op push function
    if (isHandle(item)) {
      // Silent mode - return a function that does nothing
      return (_dataOrFn: unknown) => {
        // Intentionally empty - don't push handle data during proactive caching
      };
    }

    // Loader case: same as setupLoaderAccess
    const loader = item as LoaderDefinition<any, any>;

    // Return cached promise if already started
    if (loaderPromises.has(loader.$$id)) {
      return loaderPromises.get(loader.$$id);
    }

    // Get loader function
    let loaderFn = loader.fn;
    if (!loaderFn) {
      const fetchable = getFetchableLoader(loader.$$id);
      if (fetchable) {
        loaderFn = fetchable.fn;
      }
    }

    if (!loaderFn) {
      throw new Error(
        `Loader "${loader.$$id}" has no function. This usually means the loader was defined without "use server" and the function was not included in the build.`
      );
    }

    // Create loader context with recursive use() support
    const loaderCtx: LoaderContext<Record<string, string | undefined>, TEnv> = {
      params: ctx.params,
      request: ctx.request,
      searchParams: ctx.searchParams,
      pathname: ctx.pathname,
      url: ctx.url,
      env: ctx.env,
      var: ctx.var,
      get: ctx.get,
      use: <TDep, TDepParams = any>(
        dep: LoaderDefinition<TDep, TDepParams>
      ): Promise<TDep> => {
        return ctx.use(dep);
      },
      method: "GET",
      body: undefined,
    };

    // Start loader execution with tracking
    const doneLoader = track(`loader:${loader.$$id}`);
    const promise = Promise.resolve(
      loaderFn(loaderCtx as LoaderContext<any, TEnv>)
    ).finally(() => {
      doneLoader();
    });

    loaderPromises.set(loader.$$id, promise);
    return promise;
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
  onSkip: () => T
): Promise<T> {
  const needsRevalidation = await shouldRevalidate();
  return needsRevalidation ? await onRevalidate() : onSkip();
}
