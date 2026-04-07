"use client";

import {
  isValidElement,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { OutletContext, type OutletContextValue } from "./outlet-context.js";
import type { LoaderDefinition, LoadOptions } from "./types.js";

/**
 * Extract a specific loader's data from a content ReactNode.
 *
 * When a route registers loaders via loader(), the resolved data lives in
 * the route's OutletProvider (rendered as <Outlet /> content). Parallel
 * slots are siblings of <Outlet />, so they can't find it by walking
 * the parent context chain. This helper traverses wrapper elements
 * (MountContextProvider, ViewTransition, etc.) to reach the OutletProvider
 * and extract the loader data directly.
 */
const NOT_FOUND = Symbol("not-found");

function extractContentLoaderData(
  node: ReactNode,
  loaderId: string,
): unknown | typeof NOT_FOUND {
  if (!isValidElement(node)) return NOT_FOUND;
  const props = node.props as Record<string, any> | undefined;
  if (!props) return NOT_FOUND;

  // Direct OutletProvider with loaderData
  if (props.loaderData && loaderId in props.loaderData) {
    return props.loaderData[loaderId];
  }

  // LoaderBoundary: loaderIds + loaderDataPromise (already resolved array).
  // When the segment has loading(), loaderData is resolved inside
  // LoaderBoundary via use(). If the promise was pre-awaited (forceAwait
  // or isAction), the prop is a raw array we can index into.
  if (
    props.loaderIds &&
    Array.isArray(props.loaderIds) &&
    props.loaderDataPromise &&
    !(props.loaderDataPromise instanceof Promise)
  ) {
    const idx = (props.loaderIds as string[]).indexOf(loaderId);
    if (idx !== -1) {
      const data = (props.loaderDataPromise as any[])[idx];
      // loaderDataPromise entries may be { ok, data } result objects
      if (data && typeof data === "object" && "ok" in data) {
        return data.ok ? data.data : NOT_FOUND;
      }
      return data;
    }
  }

  // Traverse into wrapper elements (MountContextProvider, ViewTransition,
  // Suspense wrappers, etc.)
  if (props.children) return extractContentLoaderData(props.children, loaderId);
  return NOT_FOUND;
}

/**
 * Payload returned by loader RSC requests
 */
interface LoaderRscPayload<T = unknown> {
  loaderResult: T;
  loaderError?: { message: string; name: string };
}

/**
 * Load function type for fetching loader data from the client
 */
export type LoadFunction<T> = (options?: LoadOptions) => Promise<T>;

/**
 * Result type for useLoader hook (strict - data is required)
 */
export interface UseLoaderResult<T> {
  /** The loaded data - guaranteed to exist when loader is registered on route */
  data: T;
  /** True while a load() is in progress */
  isLoading: boolean;
  /** Error from the most recent load attempt, null if successful */
  error: Error | null;
  /** Function to trigger a fetch (only works if loader is fetchable) */
  load: LoadFunction<T>;
  /** Alias for load */
  refetch: LoadFunction<T>;
}

/**
 * Result type for useFetchLoader hook (flexible - data is optional)
 */
export interface UseFetchLoaderResult<T> {
  /** The loaded data - may be undefined if not yet fetched or not in context */
  data: T | undefined;
  /** True while a load() is in progress */
  isLoading: boolean;
  /** Error from the most recent load attempt, null if successful */
  error: Error | null;
  /** Function to trigger a fetch (only works if loader is fetchable) */
  load: LoadFunction<T>;
  /** Alias for load */
  refetch: LoadFunction<T>;
}

/**
 * Options for useLoader hook
 */
export interface UseLoaderOptions {
  /**
   * If true (default), errors from load() will be thrown to the nearest error boundary.
   * If false, errors are only captured in the `error` state.
   * @default true
   */
  throwOnError?: boolean;
}

/**
 * Internal hook implementation shared by useLoader and useFetchLoader
 */
function useLoaderInternal<T>(
  loader: LoaderDefinition<T>,
  options?: UseLoaderOptions,
): UseFetchLoaderResult<T> {
  const context = useContext(OutletContext);

  // Get data from context (SSR/navigation)
  const contextData = useMemo((): T | undefined => {
    let current: OutletContextValue | null | undefined = context;
    while (current) {
      if (current.loaderData && loader.$$id in current.loaderData) {
        return current.loaderData[loader.$$id] as T;
      }
      // Check content element — the route's OutletProvider is rendered as
      // <Outlet /> content (a child), so its loaderData isn't in the parent
      // chain. Parallel slots need to reach into it to find route-level loaders.
      const contentData = extractContentLoaderData(
        current.content,
        loader.$$id,
      );
      if (contentData !== NOT_FOUND) {
        return contentData as T;
      }
      current = current.parent;
    }
    return undefined;
  }, [context, loader.$$id]);

  // Local state for fetched data (from load() calls)
  const [fetchedData, setFetchedData] = useState<T | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const requestIdRef = useRef(0);

  // Track context data changes to reset fetched data on navigation
  const prevContextDataRef = useRef(contextData);
  useEffect(() => {
    if (prevContextDataRef.current !== contextData) {
      // Navigation happened, clear fetched data so context takes precedence
      setFetchedData(undefined);
      setError(null);
      prevContextDataRef.current = contextData;
    }
  }, [contextData]);

  // Data priority: fetched data (if any) > context data
  const data = fetchedData ?? contextData;

  const throwOnError = options?.throwOnError ?? true;

  // Refs for values used inside load() that should NOT cause callback identity
  // churn. loader.$$id can change if a reusable component receives a different
  // loader without remounting; data changes on every navigation. Refs keep the
  // callback stable while always reading the latest values.
  const loaderIdRef = useRef(loader.$$id);
  loaderIdRef.current = loader.$$id;
  const dataRef = useRef(data);
  dataRef.current = data;

  // Load function for fetching data via the ?_rsc_loader endpoint.
  // Supports GET (data fetching) and POST/PUT/PATCH/DELETE (mutations).
  const load = useCallback(
    async (loadOptions?: LoadOptions): Promise<T> => {
      const requestId = ++requestIdRef.current;
      const loaderId = loaderIdRef.current;
      // Verify the loader has $$id
      if (!loaderId) {
        throw new Error(
          `Loader is missing $$id. Make sure the exposeLoaderId Vite plugin is enabled.`,
        );
      }

      setIsLoading(true);
      setError(null);

      try {
        const url = new URL(window.location.href);
        url.searchParams.set("_rsc_loader", loaderId);

        const method = loadOptions?.method ?? "GET";
        const isBodyMethod = method !== "GET";

        let fetchOptions: RequestInit;

        if (isBodyMethod) {
          const bodyValue =
            "body" in (loadOptions ?? {})
              ? (loadOptions as any).body
              : undefined;
          const hasParams =
            loadOptions?.params && Object.keys(loadOptions.params).length > 0;

          if (bodyValue instanceof FormData) {
            // FormData body — send as multipart/form-data (preserves File objects).
            // Params are appended as a JSON string in a special field.
            if (hasParams) {
              bodyValue.set(
                "_rsc_loader_params",
                JSON.stringify(loadOptions!.params),
              );
            }
            fetchOptions = {
              method,
              headers: { Accept: "text/x-component" },
              body: bodyValue,
            };
          } else {
            // JSON body — send params and body as JSON
            const bodyPayload: {
              params?: Record<string, string>;
              body?: unknown;
            } = {};
            if (hasParams) {
              bodyPayload.params = loadOptions!.params;
            }
            if (bodyValue !== undefined) {
              bodyPayload.body = bodyValue;
            }

            fetchOptions = {
              method,
              headers: {
                Accept: "text/x-component",
                "Content-Type": "application/json",
              },
              body: JSON.stringify(bodyPayload),
            };
          }
        } else {
          // GET - send params in query string
          if (
            loadOptions?.params &&
            Object.keys(loadOptions.params).length > 0
          ) {
            url.searchParams.set(
              "_rsc_loader_params",
              JSON.stringify(loadOptions.params),
            );
          }

          fetchOptions = {
            method: "GET",
            headers: {
              Accept: "text/x-component",
            },
          };
        }

        const response = fetch(url.toString(), fetchOptions);

        const { createFromFetch } = await import("./deps/browser.js");
        const payload = await createFromFetch<LoaderRscPayload<T>>(response);

        if (payload.loaderError) {
          throw new Error(payload.loaderError.message);
        }

        const result = payload.loaderResult;
        if (requestId === requestIdRef.current) {
          startTransition(() => {
            setFetchedData(result);
          });
        }
        return result;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        if (requestId === requestIdRef.current) {
          setError(err);
        }
        if (throwOnError) {
          throw err;
        }
        // When throwOnError is false, return the latest data snapshot (previous
        // successful value or undefined). Caller should check error state.
        return dataRef.current as T;
      } finally {
        if (requestId === requestIdRef.current) {
          setIsLoading(false);
        }
      }
    },
    [throwOnError],
  );

  // Throw during render if there's an error and throwOnError is true
  // This allows ErrorBoundaries to catch async errors from load()
  if (error && throwOnError) {
    throw error;
  }

  return {
    data,
    isLoading,
    error,
    load,
    refetch: load,
  };
}

/**
 * Hook to access loader data from route context (strict version)
 *
 * Use this when the loader is registered on the route via `loader()`.
 * The data is guaranteed to exist - throws an error if not found.
 *
 * For on-demand fetching or when loader might not be in context,
 * use `useFetchLoader` instead.
 *
 * @param loader - The loader definition (must be registered on route)
 * @param options - Optional configuration
 * @returns Object with data (guaranteed), isLoading, error, load, and refetch
 * @throws Error if loader data is not found in context
 *
 * @example Basic usage - accessing route loader data
 * ```tsx
 * "use client";
 * import { useLoader } from "rsc-router/client";
 * import { CartLoader } from "../loaders/cart";
 *
 * // In route definition: loader(CartLoader)
 *
 * export function CartIcon() {
 *   const { data } = useLoader(CartLoader);
 *   // data is guaranteed to be CartData, not CartData | undefined
 *   return <span>Cart ({data.items.length})</span>;
 * }
 * ```
 */
export function useLoader<T>(
  loader: LoaderDefinition<T>,
  options?: UseLoaderOptions,
): UseLoaderResult<T> {
  const result = useLoaderInternal(loader, options);

  // Strict mode: throw if data is not in context
  if (result.data === undefined) {
    throw new Error(
      `useLoader: Loader "${loader.$$id}" data not found in context. ` +
        `Make sure the loader is registered on the route with loader(). ` +
        `If you need on-demand fetching, use useFetchLoader() instead.`,
    );
  }

  return result as UseLoaderResult<T>;
}

/**
 * Hook to access loader data with optional fetching (flexible version)
 *
 * Use this when:
 * - The loader might not be registered on the route
 * - You want to fetch data on-demand from the client
 * - You're building a reusable component that doesn't assume route context
 *
 * If the loader IS registered on the route, it will still get the initial
 * data from context - you just have to handle the `undefined` case in types.
 *
 * @param loader - The loader definition
 * @param options - Optional configuration
 * @returns Object with data (may be undefined), isLoading, error, load, and refetch
 *
 * @example On-demand fetching
 * ```tsx
 * "use client";
 * import { useFetchLoader } from "rsc-router/client";
 * import { SearchLoader } from "../loaders/search";
 *
 * export function SearchResults() {
 *   const { data, load, isLoading } = useFetchLoader(SearchLoader);
 *
 *   const handleSearch = async (query: string) => {
 *     await load({ params: { query } });
 *   };
 *
 *   return (
 *     <div>
 *       <button onClick={() => handleSearch("test")}>Search</button>
 *       {isLoading && <span>Loading...</span>}
 *       {data?.results.map(r => <div key={r.id}>{r.name}</div>)}
 *     </div>
 *   );
 * }
 * ```
 *
 * @example With route context (hybrid usage)
 * ```tsx
 * // Loader registered on route: loader(UserLoader)
 * // useFetchLoader still works - gets initial data from context
 * const { data, load } = useFetchLoader(UserLoader);
 * // data is UserData | undefined (even though it will have initial value)
 * ```
 */
export function useFetchLoader<T>(
  loader: LoaderDefinition<T>,
  options?: UseLoaderOptions,
): UseFetchLoaderResult<T> {
  return useLoaderInternal(loader, options);
}
