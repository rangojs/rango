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

function isShareableGet(options: LoadOptions | undefined): boolean {
  if (!options) return true;
  if (options.method && options.method !== "GET") return false;
  if ("body" in options && (options as { body?: unknown }).body !== undefined) {
    return false;
  }
  return true;
}

function isPlainRefetch(options: LoadOptions | undefined): boolean {
  if (!isShareableGet(options)) return false;
  if (options?.params && Object.keys(options.params).length > 0) return false;
  return true;
}

let privateGroupBucketSeq = 0;

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

  if (
    props.loaderIds &&
    Array.isArray(props.loaderIds) &&
    props.loaderDataPromise &&
    !(props.loaderDataPromise instanceof Promise)
  ) {
    const idx = (props.loaderIds as string[]).indexOf(loaderId);
    if (idx !== -1) {
      const data = (props.loaderDataPromise as any[])[idx];
      if (data && typeof data === "object" && "ok" in data) {
        return data.ok ? data.data : NOT_FOUND;
      }
      return data;
    }
  }

  if (props.children) return extractContentLoaderData(props.children, loaderId);
  return NOT_FOUND;
}

interface LoaderRscPayload<T = unknown> {
  loaderResult: T;
  loaderError?: { message: string; name: string };
}

export type LoadFunction<T> = (options?: LoadOptions) => Promise<T>;

export interface UseLoaderResult<T> {
  data: T;
  isLoading: boolean;
  error: Error | null;
  load: LoadFunction<T>;
  refetch: LoadFunction<T>;
}

export interface UseFetchLoaderResult<T> {
  data: T | undefined;
  isLoading: boolean;
  error: Error | null;
  load: LoadFunction<T>;
  refetch: LoadFunction<T>;
}

export interface UseLoaderOptions {
  throwOnError?: boolean;
  key?: string;
  refreshGroup?: string | string[];
}

function useLoaderInternal<T>(
  loader: LoaderDefinition<T>,
  options?: UseLoaderOptions,
): UseFetchLoaderResult<T> {
  const context = useContext(OutletContext);

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

  const loaderId = loader.$$id;
  const key = options?.key;
  const refreshGroupOption = options?.refreshGroup;
  const groupKey =
    refreshGroupOption === undefined
      ? ""
      : JSON.stringify(
          typeof refreshGroupOption === "string"
            ? [refreshGroupOption]
            : [...new Set(refreshGroupOption)].sort(),
        );
  const groupList = useMemo<string[]>(
    () => (groupKey === "" ? [] : (JSON.parse(groupKey) as string[])),
    [groupKey],
  );
  const hasGroups = groupList.length > 0;
  const privateBucketIdRef = useRef<string | null>(null);
  if (hasGroups && key === undefined && privateBucketIdRef.current === null) {
    privateBucketIdRef.current = `__rg${privateGroupBucketSeq++}`;
  }
  const effectiveKey =
    key ?? (hasGroups ? privateBucketIdRef.current! : undefined);
  const bucketKey =
    effectiveKey === undefined ? loaderId : `${loaderId}::${effectiveKey}`;

  const groupRefetch = useCallback(async (): Promise<void> => {
    if (!loaderId) return;
    const requestId = loaderStore.reserveRequestId(bucketKey);
    loaderStore.beginRequest(bucketKey, requestId);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("_rsc_loader", loaderId);
      const response = fetch(url.toString(), {
        method: "GET",
        headers: { Accept: "text/x-component" },
      });
      const { createFromFetch } = await import("./deps/browser.js");
      const payload = await createFromFetch<LoaderRscPayload<T>>(response);
      if (payload.loaderError) {
        throw new Error(payload.loaderError.message);
      }
      loaderStore.finishData(bucketKey, requestId, payload.loaderResult);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      loaderStore.finishError(bucketKey, requestId, err);
      throw err;
    } finally {
      loaderStore.setLoading(bucketKey, requestId, false);
    }
  }, [loaderId, bucketKey]);

  const [sharedState, setSharedState] = useState<{
    bucketKey: string;
    snapshot: LoaderEntry;
  }>(() => ({
    bucketKey,
    snapshot: loaderStore.getSnapshot(bucketKey),
  }));
  const sharedSnapshot =
    sharedState.bucketKey === bucketKey
      ? sharedState.snapshot
      : loaderStore.getSnapshot(bucketKey);
  useEffect(() => {
    const initial = loaderStore.getSnapshot(bucketKey);
    if (initial !== sharedSnapshot) {
      startTransition(() => {
        setSharedState({ bucketKey, snapshot: initial });
      });
    }
    // ephemeral: a reader with no route context has no route-context reset
    // trigger, so its keyed bucket is reference-counted by the store. A
    // route-registered reader makes the bucket sticky (reset via clearFamily).
    return loaderStore.subscribe(
      bucketKey,
      () => {
        const next = loaderStore.getSnapshot(bucketKey);
        startTransition(() => {
          setSharedState({ bucketKey, snapshot: next });
        });
      },
      {
        loaderId,
        ephemeral: !hasContextData,
        group: hasGroups ? groupList : undefined,
        refetch: hasGroups ? groupRefetch : undefined,
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional:
    // sharedSnapshot is captured for the one-shot init sync; we don't want
    // to re-subscribe on every snapshot change. bucketKey, hasContextData,
    // groupKey, and groupRefetch are the only inputs that require a fresh
    // subscription (groupList is memoized on groupKey; groupRefetch is stable
    // per bucketKey).
  }, [bucketKey, hasContextData, groupKey, groupRefetch]);

  // Local state holds the result of:
  //   - parameterized / mutation `load()` calls (load({ params }), POST,
  //     etc.) — stay scoped so concurrent same-loader different-params
  //     fetches don't clobber each other through the shared store;
  //   - any `load()` made by hooks that are NOT in route context (i.e.
  //     useFetchLoader of an unregistered loader) — keeping those local
  //     prevents two unrelated components from accidentally sharing data
  //     through the global store just because they reference the same
  //     loader id.
  // `has` distinguishes a committed local result (including `null`/`undefined`)
  // from "no local load yet", so a load() that resolves to a falsy value is not
  // discarded in favor of the shared snapshot or the seeded context.
  const [localFetchedData, setLocalFetchedData] = useState<{
    has: boolean;
    value: T | undefined;
  }>({ has: false, value: undefined });
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
      setLocalFetchedData({ has: false, value: undefined });
      setLocalIsLoading(false);
      setLocalError(null);
      lastSharedRequestIdRef.current = null;
      // Reset every sticky bucket of this loader (keyed or not). Ephemeral
      // (unregistered keyed) buckets are left to their refcount lifecycle.
      loaderStore.clearFamily(loaderId);
      prevContextDataRef.current = contextData;
    }
  }, [contextData, loaderId]);

  // Read priority: a committed parameterized load() result overrides the shared
  // snapshot; a committed shared snapshot overrides the server-seeded context.
  // `has`/`hasValue` gate each level so a committed falsy value is not skipped.
  const data = localFetchedData.has
    ? localFetchedData.value
    : sharedSnapshot.hasValue
      ? (sharedSnapshot.value as T | undefined)
      : contextData;
  const isLoading = localIsLoading || sharedSnapshot.isLoading;
  const error = localError ?? sharedSnapshot.error;

  const throwOnError = options?.throwOnError ?? true;

  const loaderIdRef = useRef(loaderId);
  loaderIdRef.current = loaderId;
  const bucketKeyRef = useRef(bucketKey);
  bucketKeyRef.current = bucketKey;
  const dataRef = useRef(data);
  dataRef.current = data;
  const hasContextDataRef = useRef(hasContextData);
  hasContextDataRef.current = hasContextData;

  const load = useCallback(
    async (loadOptions?: LoadOptions): Promise<T> => {
      const id = loaderIdRef.current;
      if (!id) {
        throw new Error(
          `Loader is missing $$id. Make sure the exposeLoaderId Vite plugin is enabled.`,
        );
      }

      const bucket = bucketKeyRef.current;
      const hasDedicatedBucket = bucket !== id;

      const shared = hasDedicatedBucket
        ? isShareableGet(loadOptions)
        : isPlainRefetch(loadOptions) && hasContextDataRef.current;
      let sharedRequestId = -1;
      let localRequestId = -1;
      if (shared) {
        sharedRequestId = loaderStore.reserveRequestId(bucket);
        lastSharedRequestIdRef.current = sharedRequestId;
        loaderStore.beginRequest(bucket, sharedRequestId);
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
          loaderStore.finishData(bucket, sharedRequestId, result);
        } else if (localRequestId === localRequestIdRef.current) {
          startTransition(() => {
            setLocalFetchedData({ has: true, value: result });
            setLocalIsLoading(false);
          });
        }
        return result;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        if (shared) {
          loaderStore.finishError(bucket, sharedRequestId, err);
        } else if (localRequestId === localRequestIdRef.current) {
          setLocalError(err);
          setLocalIsLoading(false);
        }
        if (throwOnError) {
          throw err;
        }
        return dataRef.current as T;
      } finally {
        if (shared) {
          loaderStore.setLoading(bucket, sharedRequestId, false);
        }
      }
    },
    [throwOnError],
  );

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

/**
 * Get a stable function that refreshes loaders by cross-loader group tag.
 *
 * The returned `refresh(groups)` takes one group name or an array of names and
 * re-runs every currently-mounted read tagged with ANY of them, with a plain GET
 * against the current route URL. This is the cross-loader counterpart to the
 * single-loader `key`: use it to refresh a set of DIFFERENT loaders together
 * (e.g. profile + orders after an account switch). Members are tagged via
 * `useLoader(Loader, { refreshGroup })` / `useFetchLoader(Loader, { refreshGroup })`,
 * where `refreshGroup` is one name or several.
 *
 * Passing the group(s) to the returned function rather than to the hook lets a
 * single `useRefreshLoaders()` instance refresh different groups depending on
 * context, and lets one call refresh several groups at once — their members are
 * unioned and deduped, so a loader tagged into two of the named groups is fetched
 * exactly once.
 *
 * Group refresh never render-throws: a failing member surfaces its error via
 * that read's `error` state, and the returned promise rejects with an
 * `AggregateError` of the failures so the caller can handle them at the await
 * site. Each loader is refreshed in place — no params, no body, no mutations.
 *
 * @example
 * ```tsx
 * "use client";
 * import { useLoader, useRefreshLoaders } from "rsc-router/client";
 *
 * function Profile() {
 *   const { data } = useLoader(ProfileLoader, { key: userId, refreshGroup: "account" });
 *   return <span>{data.name}</span>;
 * }
 * function Orders() {
 *   // Tagged into two groups: refreshed by "account" (the whole set) or "orders".
 *   const { data } = useLoader(OrdersLoader, {
 *     key: userId,
 *     refreshGroup: ["account", "orders"],
 *   });
 *   return <span>{data.count} orders</span>;
 * }
 * function RefreshButtons() {
 *   const refresh = useRefreshLoaders();
 *   return (
 *     <>
 *       <button onClick={() => refresh("account")}>Refresh account</button>
 *       <button onClick={() => refresh("orders")}>Refresh orders</button>
 *       <button onClick={() => refresh(["account", "orders"])}>Refresh both</button>
 *     </>
 *   );
 * }
 * ```
 */
export function useRefreshLoaders(): (
  groups: string | string[],
) => Promise<void> {
  return useCallback(
    (groups: string | string[]) => loaderStore.refreshGroups(groups),
    [],
  );
}
