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
  LoaderDefinition,
  LoaderContext,
  LoaderDataResult,
  ErrorBoundaryHandler,
  ErrorBoundaryFallbackProps,
  ErrorInfo,
} from "../types";
import type { LoaderRevalidationResult, ActionContext } from "./types";

/**
 * Wrap a loader promise with error handling for deferred client-side resolution.
 * Catches errors and converts them to LoaderDataResult objects that include
 * error info and pre-rendered fallback UI when an error boundary is available.
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
  ) => ErrorInfo
): Promise<LoaderDataResult<T>> {
  return promise
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
 * Set up the use() method on handler context to lazily run loaders
 * Loaders are started on first call to ctx.use() and memoized for subsequent calls
 */
export function setupLoaderAccess<TEnv>(
  ctx: HandlerContext<any, TEnv>,
  loaderPromises: Map<string, Promise<any>>
): void {
  ctx.use = <T, TLoaderParams = any>(
    loader: LoaderDefinition<T, TLoaderParams>
  ): Promise<T> => {
    // Return cached promise if already started
    if (loaderPromises.has(loader.name)) {
      return loaderPromises.get(loader.name) as Promise<T>;
    }

    // Ensure loader has a function
    if (!loader.fn) {
      throw new Error(
        `Loader "${loader.name}" has no function. This usually means the loader was defined without "use server" and the function was not included in the build.`
      );
    }

    // Create loader context with recursive use() support
    const loaderCtx: LoaderContext<
      Record<string, string | undefined>,
      TEnv
    > = {
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
    };

    // Start loader execution with tracking
    const doneLoader = track(`loader:${loader.name}`);
    const promise = Promise.resolve(
      loader.fn(loaderCtx as LoaderContext<TLoaderParams, TEnv>)
    ).finally(() => {
      doneLoader();
    });

    // Memoize for subsequent calls
    loaderPromises.set(loader.name, promise);

    return promise as Promise<T>;
  };
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
