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
import { loaderStore, type LoaderEntry } from "./loader-store.js";
import type { LoaderDefinition, LoadOptions } from "./types.js";

/**
 * Plain route-context refetch — a `load()` call with no options or a
 * trivially-defaulted GET (no params, no body). Results from these are
 * broadcast to every component reading the same loader id via the shared
 * store, so a layout's refetch button updates page + parallel-slot reads
 * automatically.
 *
 * Calls with explicit `params`, an explicit non-GET method, or a `body`
 * stay local to the call site — that preserves the today-semantics of
 * `useFetchLoader(SearchLoader).load({ params: { q } })` style code where
 * each component owns its own fetched view.
 */
function isPlainRefetch(options: LoadOptions | undefined): boolean {
  if (!options) return true;
  if (options.method && options.method !== "GET") return false;
  if (options.params && Object.keys(options.params).length > 0) return false;
  if ("body" in options && (options as { body?: unknown }).body !== undefined) {
    return false;
  }
  return true;
}

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

  // Get data from context (SSR/navigation). `hasContextData` distinguishes
  // "loader registered on the route, value happens to be undefined" from
  // "loader is not in any parent's context at all". The shared store is
  // only consulted when the loader really is in route context — that
  // preserves per-component isolation for ad-hoc useFetchLoader callers
  // who use the same fetchable loader without registering it.
  const { contextData, hasContextData } = useMemo((): {
    contextData: T | undefined;
    hasContextData: boolean;
  } => {
    let current: OutletContextValue | null | undefined = context;
    while (current) {
      if (current.loaderData && loader.$$id in current.loaderData) {
        return {
          contextData: current.loaderData[loader.$$id] as T,
          hasContextData: true,
        };
      }
      // Check content element — the route's OutletProvider is rendered as
      // <Outlet /> content (a child), so its loaderData isn't in the parent
      // chain. Parallel slots need to reach into it to find route-level loaders.
      const contentData = extractContentLoaderData(
        current.content,
        loader.$$id,
      );
      if (contentData !== NOT_FOUND) {
        return { contextData: contentData as T, hasContextData: true };
      }
      current = current.parent;
    }
    return { contextData: undefined, hasContextData: false };
  }, [context, loader.$$id]);

  // Shared subscription: every component reading the same loader id sees
  // the same snapshot, so a plain refetch from one component propagates to
  // the others. Mirrors the convention used by useParams / useLinkStatus —
  // useState seeded from the store, useEffect subscribes for updates and
  // calls setState inside startTransition so subscriber re-renders don't
  // trip Suspense fallbacks during a refetch (matches the per-hook
  // startTransition the old code wrapped setFetchedData in).
  const loaderId = loader.$$id;
  const [sharedState, setSharedState] = useState<{
    loaderId: string;
    snapshot: LoaderEntry;
  }>(() => ({
    loaderId,
    snapshot: loaderStore.getSnapshot(loaderId),
  }));
  const sharedSnapshot =
    sharedState.loaderId === loaderId
      ? sharedState.snapshot
      : loaderStore.getSnapshot(loaderId);
  useEffect(() => {
    // Sync any value the store committed between this hook's lazy
    // initializer and effect-time (e.g. a sibling that mounted earlier
    // already triggered a load()).
    const initial = loaderStore.getSnapshot(loaderId);
    if (initial !== sharedSnapshot) {
      startTransition(() => {
        setSharedState({ loaderId, snapshot: initial });
      });
    }
    return loaderStore.subscribe(loaderId, () => {
      const next = loaderStore.getSnapshot(loaderId);
      startTransition(() => {
        setSharedState({ loaderId, snapshot: next });
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional:
    // sharedSnapshot is captured for the one-shot init sync; we don't want
    // to re-subscribe on every snapshot change.
  }, [loaderId]);

  // Local state holds the result of:
  //   - parameterized / mutation `load()` calls (load({ params }), POST,
  //     etc.) — stay scoped so concurrent same-loader different-params
  //     fetches don't clobber each other through the shared store;
  //   - any `load()` made by hooks that are NOT in route context (i.e.
  //     useFetchLoader of an unregistered loader) — keeping those local
  //     prevents two unrelated components from accidentally sharing data
  //     through the global store just because they reference the same
  //     loader id.
  const [localFetchedData, setLocalFetchedData] = useState<T | undefined>(
    undefined,
  );
  const [localIsLoading, setLocalIsLoading] = useState(false);
  const [localError, setLocalError] = useState<Error | null>(null);

  // Local request id, mirrors the per-hook gating the previous
  // implementation provided. Two quick parameterized loads from the same
  // hook (e.g. load({ params: { q: "a" } }) then load({ params: { q: "b" } }))
  // can resolve out of order — only the latest must commit.
  const localRequestIdRef = useRef(0);

  // Tracks the request id of the most recent SHARED load() this hook
  // initiated. The render-throw rule below uses it to scope the throw
  // to the originating hook only — sibling readers see the error in
  // `error` but don't blow up their own boundaries.
  const lastSharedRequestIdRef = useRef<number | null>(null);

  // Reset on navigation. clear() bumps the entry's latest request id so
  // any pre-navigation load() promise that resolves later fails its gate
  // and is dropped — fixes the race where a stale fetch overwrites the
  // new route's context.
  const prevContextDataRef = useRef(contextData);
  useEffect(() => {
    if (prevContextDataRef.current !== contextData) {
      setLocalFetchedData(undefined);
      setLocalIsLoading(false);
      setLocalError(null);
      lastSharedRequestIdRef.current = null;
      loaderStore.clear(loaderId);
      prevContextDataRef.current = contextData;
    }
  }, [contextData, loaderId]);

  // Read priority: a parameterized load() result overrides the shared
  // snapshot; the shared snapshot overrides the server-seeded context.
  const data =
    localFetchedData ?? (sharedSnapshot.value as T | undefined) ?? contextData;
  const isLoading = localIsLoading || sharedSnapshot.isLoading;
  const error = localError ?? sharedSnapshot.error;

  const throwOnError = options?.throwOnError ?? true;

  // Refs for values used inside load() that should NOT cause callback identity
  // churn. loader.$$id can change if a reusable component receives a different
  // loader without remounting; data changes on every navigation. Refs keep the
  // callback stable while always reading the latest values.
  const loaderIdRef = useRef(loaderId);
  loaderIdRef.current = loaderId;
  const dataRef = useRef(data);
  dataRef.current = data;
  const hasContextDataRef = useRef(hasContextData);
  hasContextDataRef.current = hasContextData;

  // Load function for fetching data via the ?_rsc_loader endpoint.
  // Supports GET (data fetching) and POST/PUT/PATCH/DELETE (mutations).
  const load = useCallback(
    async (loadOptions?: LoadOptions): Promise<T> => {
      const id = loaderIdRef.current;
      if (!id) {
        throw new Error(
          `Loader is missing $$id. Make sure the exposeLoaderId Vite plugin is enabled.`,
        );
      }

      // Sharing the result is only correct when the loader is actually
      // registered on the route — otherwise two unrelated components
      // calling load() on the same fetchable loader would suddenly start
      // overwriting each other's local view through the global store.
      const shared = isPlainRefetch(loadOptions) && hasContextDataRef.current;
      let sharedRequestId = -1;
      let localRequestId = -1;
      if (shared) {
        sharedRequestId = loaderStore.reserveRequestId(id);
        lastSharedRequestIdRef.current = sharedRequestId;
        // beginRequest flips loading on AND clears any prior error so a
        // throwOnError: false consumer doesn't keep showing the stale
        // error during the retry. Gated on requestId === latest.
        loaderStore.beginRequest(id, sharedRequestId);
      } else {
        localRequestId = ++localRequestIdRef.current;
        setLocalIsLoading(true);
        setLocalError(null);
      }

      try {
        const url = new URL(window.location.href);
        url.searchParams.set("_rsc_loader", id);

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
        if (shared) {
          // finishData is gated on requestId; a stale response is dropped.
          loaderStore.finishData(id, sharedRequestId, result);
        } else if (localRequestId === localRequestIdRef.current) {
          // Local-branch gate, mirrors the shared-branch requestId check:
          // if a newer load() was issued from this hook before this one
          // resolved, drop the stale result.
          startTransition(() => {
            setLocalFetchedData(result);
            setLocalIsLoading(false);
          });
        }
        return result;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        if (shared) {
          loaderStore.finishError(id, sharedRequestId, err);
        } else if (localRequestId === localRequestIdRef.current) {
          setLocalError(err);
          setLocalIsLoading(false);
        }
        if (throwOnError) {
          throw err;
        }
        // When throwOnError is false, return the latest data snapshot (previous
        // successful value or undefined). Caller should check error state.
        return dataRef.current as T;
      } finally {
        if (shared) {
          // setLoading is gated; only the latest request flips the flag off.
          loaderStore.setLoading(id, sharedRequestId, false);
        }
      }
    },
    [throwOnError],
  );

  // Throw during render if there's an error and throwOnError is true.
  // - Local errors always belong to this hook, so always throw on opt-in.
  // - Shared errors throw only when this hook initiated the failing
  //   request (entry.requestId matches lastSharedRequestIdRef). Sibling
  //   readers expose the error via `error` but do not throw, so a
  //   throwOnError: true reader never explodes because of someone else's
  //   throwOnError: false load() failure.
  if (throwOnError) {
    if (localError) throw localError;
    if (
      sharedSnapshot.error &&
      lastSharedRequestIdRef.current !== null &&
      sharedSnapshot.requestId === lastSharedRequestIdRef.current
    ) {
      throw sharedSnapshot.error;
    }
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
): UseLoaderResult<Rango.FlightSerialize<T>> {
  const result = useLoaderInternal(loader, options);

  // Strict mode: throw if data is not in context
  if (result.data === undefined) {
    throw new Error(
      `useLoader: Loader "${loader.$$id}" data not found in context. ` +
        `Make sure the loader is registered on the route with loader(). ` +
        `If you need on-demand fetching, use useFetchLoader() instead.`,
    );
  }

  return result as UseLoaderResult<Rango.FlightSerialize<T>>;
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
): UseFetchLoaderResult<Rango.FlightSerialize<T>> {
  return useLoaderInternal(loader, options) as UseFetchLoaderResult<
    Rango.FlightSerialize<T>
  >;
}
