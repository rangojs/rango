"use client";

import { useContext, useState, useEffect, useRef } from "react";
import { NavigationStoreContext } from "./context.js";
import type { ReadonlyURLSearchParams } from "../types.js";

/**
 * Hook to access the current URL search params.
 *
 * Returns a read-only URLSearchParams object from the committed location.
 * Updates when navigation completes, not during pending navigation.
 *
 * Note: During SSR the search params are not available (the server only sends
 * the pathname). The hook returns empty params during SSR and syncs from
 * the browser URL on mount.
 *
 * @example
 * ```tsx
 * const searchParams = useSearchParams();
 * const query = searchParams.get("q"); // "react"
 * const page = searchParams.get("page"); // "2"
 * ```
 */
export function useSearchParams(): ReadonlyURLSearchParams {
  const ctx = useContext(NavigationStoreContext);

  const [searchParams, setSearchParams] = useState<ReadonlyURLSearchParams>(
    () => new URLSearchParams(),
  );

  const prevSearch = useRef("");

  useEffect(() => {
    if (!ctx) return;

    const update = () => {
      const location = ctx.eventController.getState().location as URL;
      const nextSearch = location.searchParams.toString();
      if (nextSearch !== prevSearch.current) {
        prevSearch.current = nextSearch;
        setSearchParams(new URLSearchParams(nextSearch));
      }
    };

    update();

    return ctx.eventController.subscribe(update);
  }, []);

  return searchParams;
}
