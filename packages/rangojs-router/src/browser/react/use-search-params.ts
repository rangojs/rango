"use client";

import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { NavigationStoreContext } from "./context.js";
import type { ReadonlyURLSearchParams } from "../types.js";

/**
 * Accepted shapes for the setter: a full replacement for the search string.
 * Record values are stringified; array values append one entry per element;
 * null/undefined values are skipped (ergonomic conditional spreads).
 */
export type SearchParamsInit =
  | string
  | URLSearchParams
  | ReadonlyURLSearchParams
  | Record<
      string,
      | string
      | number
      | boolean
      | readonly (string | number | boolean)[]
      | null
      | undefined
    >;

export interface SetSearchParamsOptions {
  /** Replace the current history entry instead of pushing (default false). */
  replace?: boolean;
  /** Scroll behavior for the navigation (default: router default, scroll). */
  scroll?: boolean;
  /**
   * Set false to skip the server fetch and only update the URL (default
   * true). Purely client-derived search state (open accordions, view modes)
   * needs no loader re-run; all location-aware hooks still update. Same
   * contract as NavigateOptions.revalidate — it only applies because the
   * setter never changes the pathname.
   */
  revalidate?: boolean;
}

export type SetSearchParams = (
  init: SearchParamsInit | ((prev: URLSearchParams) => SearchParamsInit),
  options?: SetSearchParamsOptions,
) => Promise<void>;

function normalizeInit(init: SearchParamsInit): URLSearchParams {
  if (typeof init === "string") return new URLSearchParams(init);
  if (init instanceof URLSearchParams) return new URLSearchParams(init);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(init)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const entry of value) params.append(key, String(entry));
    } else {
      params.append(key, String(value));
    }
  }
  return params;
}

/**
 * Hook to read and write the current URL search params
 * (React Router-style tuple).
 *
 * The first element is a read-only URLSearchParams from the COMMITTED
 * location — it updates when navigation completes, not during a pending
 * navigation. During document SSR it carries the LIVE request's search (the
 * SSR store is seeded from SSRRenderOptions.search), and the browser's
 * first render seeds from its own store location (window.location) — the
 * same URL, so hydration matches. Ppr capture/resume renders seed the SHELL
 * KEY's search (sorted, cache.searchParams filter applied — search is part
 * of shell identity like every other ppr key), so static-part reads bake
 * markup consistent with the shell's own key. Two edges: a param EXCLUDED
 * by cache.searchParams is absent in shell renders but present in the
 * browser (exclusion declares "does not affect markup" — reading one
 * anyway hydration-mismatches), and toString() renders sorted order while
 * the browser holds the raw URL order.
 *
 * The setter REPLACES the whole search string (React Router semantics) and
 * navigates to the current pathname with the new params — a same-route
 * navigation, so route loaders re-evaluate per their revalidate() contract
 * and the commit holds previous content (the same-structure transition
 * lane). Pass a function to merge with the current params: it receives a
 * MUTABLE copy read at call time. The hash is dropped, like React Router.
 *
 * @example
 * ```tsx
 * const [searchParams, setSearchParams] = useSearchParams();
 * const category = searchParams.get("category");
 *
 * // Replace the whole search string
 * setSearchParams({ category: "electronics" });
 *
 * // Merge with what's there now
 * setSearchParams((prev) => {
 *   prev.set("page", "2");
 *   return prev;
 * });
 *
 * // Filter UIs usually want replace + preserved scroll
 * setSearchParams({ category: "home" }, { replace: true, scroll: false });
 * ```
 */
export function useSearchParams(): [ReadonlyURLSearchParams, SetSearchParams] {
  const ctx = useContext(NavigationStoreContext);

  // Seed from the store location on BOTH sides (mirrors usePathname): the
  // SSR store carries the live request's search, the browser store carries
  // window.location — same URL, so the hydration renders agree. No ctx
  // (no provider) seeds empty.
  const [searchParams, setSearchParamsState] =
    useState<ReadonlyURLSearchParams>(() => {
      const location = ctx?.eventController.getState().location as
        | URL
        | undefined;
      return new URLSearchParams(location?.searchParams);
    });

  const prevSearch = useRef(searchParams.toString());

  useEffect(() => {
    if (!ctx) return;

    const update = () => {
      const location = ctx.eventController.getState().location as URL;
      const nextSearch = location.searchParams.toString();
      if (nextSearch !== prevSearch.current) {
        prevSearch.current = nextSearch;
        setSearchParamsState(new URLSearchParams(nextSearch));
      }
    };

    update();

    return ctx.eventController.subscribe(update);
  }, []);

  // Reads the committed location at CALL time (not the render closure), so a
  // functional init always merges against fresh params even when the caller's
  // closure is stale.
  const setSearchParams = useCallback<SetSearchParams>((init, options) => {
    if (!ctx) {
      throw new Error(
        "useSearchParams setter must be used within NavigationProvider",
      );
    }
    const location = ctx.eventController.getState().location as URL;
    const resolved =
      typeof init === "function"
        ? init(new URLSearchParams(location.searchParams))
        : init;
    const search = normalizeInit(resolved).toString();
    const url = search ? `${location.pathname}?${search}` : location.pathname;
    return ctx.navigate(url, {
      replace: options?.replace ?? false,
      ...(options?.scroll !== undefined ? { scroll: options.scroll } : {}),
      ...(options?.revalidate !== undefined
        ? { revalidate: options.revalidate }
        : {}),
    });
  }, []);

  return useMemo(
    () => [searchParams, setSearchParams],
    [searchParams, setSearchParams],
  );
}
