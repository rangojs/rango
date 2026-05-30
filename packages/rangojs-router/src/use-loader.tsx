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
 * A shareable GET — a `load()` call that reads data (GET or defaulted method)
 * with no request body. Params are allowed. This is the gate for keyed sharing:
 * when a hook is given an explicit `key`, every shareable GET writes to the
 * keyed bucket so co-keyed readers (including parameterized views) refresh
 * together. Non-GET methods and body-bearing calls are mutations and stay local
 * to the call site.
 */
function isShareableGet(options: LoadOptions | undefined): boolean {
  if (!options) return true;
  if (options.method && options.method !== "GET") return false;
  if ("body" in options && (options as { body?: unknown }).body !== undefined) {
    return false;
  }
  return true;
}

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
 * each component owns its own fetched view. (An explicit `key` opts a
 * parameterized GET back into sharing; see `isShareableGet`.)
 */
function isPlainRefetch(options: LoadOptions | undefined): boolean {
  if (!isShareableGet(options)) return false;
  if (options?.params && Object.keys(options.params).length > 0) return false;
  return true;
}

// Per-hook unique suffix for grouped reads that have no explicit `key`. Such a
// read must NOT share the bare `loader.$$id` bucket, or a cross-loader group
// refresh would leak into unrelated unkeyed readers of the same loader (which
// the contract keeps local). Sharing within a group is opt-in via an explicit
// `key`; without one, each grouped read gets its own private bucket. The value
// is only ever used as a client-side store bucket key (never rendered), so the
// counter has no SSR/hydration consistency requirement.
let privateGroupBucketSeq = 0;

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
  /**
   * Client refresh key. Partitions the shared refresh store so that only hooks
   * using the same `key` refresh together when one of them calls `load()`.
   *
   * Without a `key` (default), a plain `load()` on a route-registered loader
   * broadcasts to every reader of that loader, and any parameterized / unregistered
   * load stays local to the calling hook. With a `key`:
   *   - readers of the same loader that share a `key` form one refresh group —
   *     a `load()` from any of them updates the whole group, including
   *     parameterized GETs;
   *   - readers with different keys are independent;
   *   - it works even when the loader is NOT registered on the route (keyed
   *     `useFetchLoader`), letting unrelated components opt into sharing.
   *
   * This is a client-side refresh identity only. It is unrelated to the server
   * `cache({ key })` option and to `revalidate()`; it never changes the request
   * sent to the server.
   */
  key?: string;
  /**
   * Cross-loader refresh group tag(s). Tag reads of DIFFERENT loaders with a
   * shared name, then call `useRefreshLoaders()(name)` to refresh the whole group
   * at once. Pass an array to tag one read into several groups — it is refreshed
   * when ANY of its groups is refreshed, so a coarse tag can cover the whole set
   * while a finer tag targets a subset. Each member is refreshed with a plain GET
   * against the current route URL — no params, no body, no mutation methods —
   * because a group spans heterogeneous loaders with different param/return
   * shapes.
   *
   * For parameterized sharing of a SINGLE loader, use `key` instead; group
   * members should be registered or non-parameterized-keyed reads (a plain-GET
   * group refresh would drop any per-call params).
   */
  refreshGroup?: string | string[];
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
  // Client refresh key. The shared store is partitioned by bucket key so that
  // only hooks with the same `key` refresh together. Default (no key) keeps the
  // historical behavior: one bucket per loader id.
  const key = options?.key;
  // Normalize the refresh-group tag(s) to a stable, deduped, sorted list. The
  // joined `groupKey` string is the subscribe effect's dependency, so passing an
  // inline array literal (`refreshGroup={["a", "b"]}`) does not force a
  // resubscribe on every render. An empty list means "no groups" — identical to
  // omitting the option (`hasGroups` stays false, no private bucket is created).
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
  // A grouped reader with no explicit key gets a private per-hook bucket so a
  // cross-loader group refresh cannot leak into the bare `loader.$$id` bucket
  // shared by unrelated unkeyed readers. Sharing within a group is opt-in via
  // an explicit `key`.
  const privateBucketIdRef = useRef<string | null>(null);
  if (hasGroups && key === undefined && privateBucketIdRef.current === null) {
    privateBucketIdRef.current = `__rg${privateGroupBucketSeq++}`;
  }
  const effectiveKey =
    key ?? (hasGroups ? privateBucketIdRef.current! : undefined);
  const bucketKey =
    effectiveKey === undefined ? loaderId : `${loaderId}::${effectiveKey}`;

  // Plain-GET refresh thunk registered with the store for cross-loader group
  // refresh (useRefreshLoaders). Always shares into this hook's bucket, never
  // touches lastSharedRequestIdRef (so a group refresh never render-throws —
  // errors surface via `error` and reject the refreshGroups() promise instead),
  // and sends no params/body. Stable across navigations (depends only on
  // loaderId + bucketKey), so the store keeps one current thunk per bucket.
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
    // Sync any value the store committed between this hook's lazy
    // initializer and effect-time (e.g. a sibling that mounted earlier
    // already triggered a load()).
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
      // Reset every sticky bucket of this loader (keyed or not). Ephemeral
      // (unregistered keyed) buckets are left to their refcount lifecycle.
      loaderStore.clearFamily(loaderId);
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
  const bucketKeyRef = useRef(bucketKey);
  bucketKeyRef.current = bucketKey;
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

      const bucket = bucketKeyRef.current;
      // A dedicated bucket means this read owns a bucket distinct from the bare
      // loader id — either an explicit `key` (`$$id::key`) or a refreshGroup's
      // private bucket (`$$id::<private>`).
      const hasDedicatedBucket = bucket !== id;

      // Deciding shared vs local:
      //   - With a dedicated bucket, every shareable GET (params allowed) writes
      //     to that bucket — the key/group is an explicit opt-in to sharing, and
      //     a direct load() must land in the same bucket a group refresh uses.
      //   - On the bare loader-id bucket, sharing is only correct when the
      //     loader is registered on the route and the call is a plain refetch —
      //     otherwise two unrelated components calling load() on the same
      //     fetchable loader would overwrite each other's local view.
      // Mutations (non-GET / body) stay local in both cases.
      const shared = hasDedicatedBucket
        ? isShareableGet(loadOptions)
        : isPlainRefetch(loadOptions) && hasContextDataRef.current;
      let sharedRequestId = -1;
      let localRequestId = -1;
      if (shared) {
        sharedRequestId = loaderStore.reserveRequestId(bucket);
        lastSharedRequestIdRef.current = sharedRequestId;
        // beginRequest flips loading on AND clears any prior error so a
        // throwOnError: false consumer doesn't keep showing the stale
        // error during the retry. Gated on requestId === latest.
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
          loaderStore.finishData(bucket, sharedRequestId, result);
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
          loaderStore.finishError(bucket, sharedRequestId, err);
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
          loaderStore.setLoading(bucket, sharedRequestId, false);
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
