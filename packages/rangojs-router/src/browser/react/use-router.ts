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
 * Methods read `basename` from the context on each call. It is set once from
 * the initial payload and is stable within a session — a cross-app navigation
 * is a full document load (X-RSC-Reload), so the target app mounts fresh with
 * its own basename.
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

  // Stable reference: ctx itself is stable, and reads on each method call
  // pick up live basename values from the context (backed by a live ref
  // in NavigationProvider), so app-switch transitions are reflected without
  // recreating this object.
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

      prefetch(url: string, options?: { key?: ":source" }): void {
        const segmentState = ctx.store?.getSegmentState();
        if (segmentState) {
          prefetchDirect(
            withBasename(url),
            segmentState.currentSegmentIds,
            getAppVersion(),
            ctx.store?.getRouterId?.(),
            options?.key,
          );
        }
      },

      back(): void {
        // Avoid escaping the host on the first entry of this session.
        // Prefer the Navigation API; fall back to the router-stamped
        // history.state.idx (set by pushHistoryWithIdx) for older browsers.
        const nav = (window as { navigation?: { canGoBack: boolean } })
          .navigation;
        const canGoBack =
          nav && typeof nav.canGoBack === "boolean"
            ? nav.canGoBack
            : ((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0;
        if (canGoBack) {
          window.history.back();
        } else {
          ctx.navigate(withBasename("/"), { replace: true });
        }
      },

      forward(): void {
        window.history.forward();
      },
    };
  }, []);
}
