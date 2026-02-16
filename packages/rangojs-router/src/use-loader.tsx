"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { OutletContext, type OutletContextValue } from "./outlet-context.js";
import type {
  LoaderDefinition,
  AnyLoaderDefinition,
  ClientLoaderDefinition,
  IsomorphicLoaderDefinition,
  LoadOptions,
  ClientLoaderContext,
} from "./types.js";
import { getClientLoader } from "./browser/client-loader-registry.js";

/**
 * Payload returned by loader RSC requests
 */
interface LoaderRscPayload<T = unknown> {
  loaderResult: T;
  loaderError?: { message: string; name: string };
}

/**
 * Load function type with form action support
 */
export type LoadFunction<T> = ((options?: LoadOptions) => Promise<T>) & {
  /** Form action for progressive enhancement - can be passed to form action prop */
  action: (formData: FormData) => Promise<void>;
};

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
  loader: AnyLoaderDefinition<T>,
  options?: UseLoaderOptions,
): UseFetchLoaderResult<T> {
  const context = useContext(OutletContext);

  // Get data from context (SSR/navigation)
  const getContextData = useCallback((): T | undefined => {
    let current: OutletContextValue | null | undefined = context;
    while (current) {
      if (current.loaderData && loader.$$id in current.loaderData) {
        return current.loaderData[loader.$$id] as T;
      }
      current = current.parent;
    }
    return undefined;
  }, [context, loader.$$id]);

  const contextData = getContextData();

  // Local state for fetched data (from load() calls)
  const [fetchedData, setFetchedData] = useState<T | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const clientLoaderAbortRef = useRef<AbortController | null>(null);

  // Abort in-flight client loader requests on unmount
  useEffect(() => {
    return () => {
      clientLoaderAbortRef.current?.abort();
    };
  }, []);

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

  // Load function for fetching data
  const load = useCallback(
    async (loadOptions?: LoadOptions): Promise<T> => {
      // Verify the loader has $$id
      if (!loader.$$id) {
        throw new Error(
          `Loader is missing $$id. Make sure the exposeLoaderId Vite plugin is enabled.`,
        );
      }

      setIsLoading(true);
      setError(null);

      try {
        // Client/isomorphic loaders: execute client fn directly instead of
        // hitting the server. The server has no function for client loaders,
        // and isomorphic loaders should use the client fn for refetches.
        const isClientBrand =
          loader.__brand === "clientLoader" ||
          loader.__brand === "isomorphicLoader";

        if (isClientBrand && typeof window !== "undefined") {
          clientLoaderAbortRef.current?.abort();
          const controller = new AbortController();
          clientLoaderAbortRef.current = controller;

          const clientFn =
            getClientLoader(loader.$$id) ?? (loader as any).clientFn;
          if (!clientFn) {
            throw new Error(
              `Client loader "${loader.$$id}" has no registered client function. ` +
                `Ensure the loader module is imported in the client bundle.`,
            );
          }

          const currentUrl = new URL(window.location.href);
          const ctx: ClientLoaderContext = {
            params: loadOptions?.params ?? {},
            searchParams: currentUrl.searchParams,
            pathname: currentUrl.pathname,
            url: currentUrl,
            signal: controller.signal,
          };

          const result = await clientFn(ctx);
          setFetchedData(result);
          return result;
        }

        // Server loaders: fetch via _rsc_loader endpoint
        const url = new URL(window.location.pathname, window.location.origin);
        url.searchParams.set("_rsc_loader", loader.$$id);

        const method = loadOptions?.method ?? "GET";
        const isBodyMethod = method !== "GET";

        let fetchOptions: RequestInit;

        if (isBodyMethod) {
          // POST/PUT/PATCH/DELETE - send params and body as JSON
          const bodyPayload: {
            params?: Record<string, string>;
            body?: unknown;
          } = {};
          if (
            loadOptions?.params &&
            Object.keys(loadOptions.params).length > 0
          ) {
            bodyPayload.params = loadOptions.params;
          }
          if (
            "body" in (loadOptions ?? {}) &&
            (loadOptions as any).body !== undefined
          ) {
            bodyPayload.body = (loadOptions as any).body;
          }

          fetchOptions = {
            method,
            headers: {
              Accept: "text/x-component",
              "Content-Type": "application/json",
            },
            body: JSON.stringify(bodyPayload),
          };
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
        setFetchedData(result);
        return result;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        if (throwOnError) {
          throw err;
        }
        // When throwOnError is false, return the current data (previous successful
        // value or undefined). Caller should check error state for error handling.
        return data as T;
      } finally {
        setIsLoading(false);
      }
    },
    [throwOnError],
  );

  // Form action for progressive enhancement
  // This wrapper is for useFetchLoader's load.action - it manages state internally
  // and doesn't use React's useActionState. For true PE, use loader.action directly
  // with useActionState.
  const action = useCallback(
    async (formData: FormData): Promise<void> => {
      const loaderAction = (loader as any).action;
      if (!loaderAction) {
        throw new Error(
          `Loader "${loader.$$id}" does not have an action. ` +
            `Make sure the loader is created with fetchable: true.`,
        );
      }

      setIsLoading(true);
      setError(null);

      try {
        // Pass null as prevState - this wrapper manages state internally
        const result = await loaderAction(null, formData);
        setFetchedData(result);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        if (throwOnError) {
          throw err;
        }
      } finally {
        setIsLoading(false);
      }
    },
    [throwOnError],
  );

  // Attach action to load function
  const loadWithAction = load as LoadFunction<T>;
  loadWithAction.action = action;

  // Throw during render if there's an error and throwOnError is true
  // This allows ErrorBoundaries to catch async errors from load()
  if (error && throwOnError) {
    throw error;
  }

  return {
    data,
    isLoading,
    error,
    load: loadWithAction,
    refetch: loadWithAction,
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
  loader: ClientLoaderDefinition<T>,
  options?: UseLoaderOptions,
): UseFetchLoaderResult<T>;
export function useLoader<T>(
  loader: IsomorphicLoaderDefinition<T>,
  options?: UseLoaderOptions,
): UseFetchLoaderResult<T>;
export function useLoader<T>(
  loader: LoaderDefinition<T>,
  options?: UseLoaderOptions,
): UseLoaderResult<T>;
export function useLoader<T>(
  loader: AnyLoaderDefinition<T>,
  options?: UseLoaderOptions,
): UseLoaderResult<T> | UseFetchLoaderResult<T> {
  const result = useLoaderInternal(loader, options);

  // Strict mode: throw if data is not in context
  if (result.data === undefined) {
    // Client/isomorphic loaders may not have data during SSR or initial
    // hydration. Data arrives post-hydration via segment-system re-render.
    // The overloads return UseFetchLoaderResult (data: T | undefined)
    // so callers are forced to handle the undefined case.
    const isClientBrand =
      loader.__brand === "clientLoader" ||
      loader.__brand === "isomorphicLoader";
    if (isClientBrand) {
      return result;
    }

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
  loader: AnyLoaderDefinition<T>,
  options?: UseLoaderOptions,
): UseFetchLoaderResult<T> {
  return useLoaderInternal(loader, options);
}
