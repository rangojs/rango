"use client";

import { useContext, useMemo } from "react";
import { NavigationStoreContext } from "./context.js";
import { prefetchDirect } from "../prefetch/fetch.js";
import { getAppVersion } from "../app-version.js";
import type { RouterInstance, RouterNavigateOptions } from "../types.js";

/**
 * Hook to access router actions (push, replace, refresh, prefetch, back, forward).
 *
 * Returns a STABLE reference that never changes, so components using
 * useRouter() do not re-render on navigation state changes.
 * For reactive navigation state, use useNavigation() instead.
 *
 * @example
 * ```tsx
 * const router = useRouter();
 * router.push("/products");
 * router.replace("/login", { scroll: false });
 * router.prefetch("/dashboard");
 * router.back();
 * ```
 */
export function useRouter(): RouterInstance {
  const ctx = useContext(NavigationStoreContext);

  if (!ctx) {
    throw new Error("useRouter must be used within NavigationProvider");
  }

  // Stable reference: ctx is itself stable (NavigationProvider memoizes with [])
  return useMemo<RouterInstance>(() => {
    /** Prefix a root-relative path with basename if not already prefixed. */
    function withBasename(url: string): string {
      const bn = ctx!.basename;
      if (!bn || !url.startsWith("/") || url.startsWith(bn + "/") || url === bn)
        return url;
      return url === "/" ? bn : bn + url;
    }

    return {
      push(url: string, options?: RouterNavigateOptions): Promise<void> {
        return ctx.navigate(withBasename(url), { ...options, replace: false });
      },

      replace(url: string, options?: RouterNavigateOptions): Promise<void> {
        return ctx.navigate(withBasename(url), { ...options, replace: true });
      },

      refresh(): Promise<void> {
        return ctx.refresh();
      },

      prefetch(url: string): void {
        const segmentState = ctx.store?.getSegmentState();
        if (segmentState) {
          prefetchDirect(
            withBasename(url),
            segmentState.currentSegmentIds,
            getAppVersion(),
            ctx.store?.getRouterId?.(),
          );
        }
      },

      back(): void {
        window.history.back();
      },

      forward(): void {
        window.history.forward();
      },
    };
  }, []);
}
