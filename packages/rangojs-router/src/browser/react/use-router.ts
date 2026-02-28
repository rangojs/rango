"use client";

import { useContext, useMemo } from "react";
import { NavigationStoreContext } from "./context.js";
import { prefetchUrl } from "./prefetch.js";
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
    throw new Error(
      "useRouter must be used within NavigationStoreContext.Provider",
    );
  }

  // Stable reference: ctx is itself stable (NavigationProvider memoizes with [])
  return useMemo<RouterInstance>(
    () => ({
      push(url: string, options?: RouterNavigateOptions): Promise<void> {
        return ctx.navigate(url, {
          replace: false,
          scroll: options?.scroll,
          state: options?.state,
        });
      },

      replace(url: string, options?: RouterNavigateOptions): Promise<void> {
        return ctx.navigate(url, {
          replace: true,
          scroll: options?.scroll,
          state: options?.state,
        });
      },

      refresh(): Promise<void> {
        return ctx.refresh();
      },

      prefetch(url: string): void {
        // Guard for SSR where store is null
        const segmentState = ctx.store?.getSegmentState();
        if (segmentState) {
          prefetchUrl(url, segmentState.currentSegmentIds);
        }
      },

      back(): void {
        window.history.back();
      },

      forward(): void {
        window.history.forward();
      },
    }),
    [],
  );
}
