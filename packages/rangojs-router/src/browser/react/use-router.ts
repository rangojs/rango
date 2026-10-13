"use client";

import { useContext, useMemo } from "react";
import { NavigationStoreContext } from "./context.js";
import { useMount } from "./use-mount.js";
import { prefetchDirect } from "../prefetch/loader.js";
import { getAppVersion } from "../app-version.js";
import { prefixBasename } from "../../router/basename.js";
import { substitutePatternParams } from "../../router/substitute-pattern-params.js";
import { href, type ValidPaths } from "../../href-client.js";
import type { RouterInstance, RouterNavigateOptions } from "../types.js";

/**
 * Hook to access router actions (push, replace, refresh, prefetch, back, forward).
 *
 * Returns a STABLE reference per component, so components using useRouter()
 * do not re-render on navigation state changes.
 * For reactive navigation state, use useNavigation() instead.
 *
 * Methods read `basename` from the context on each call. It is set once from
 * the initial payload and is stable within a session — a cross-app navigation
 * is a full document load (X-RSC-Reload), so the target app mounts fresh with
 * its own basename.
 *
 * RELATIVE paths (no leading `/`, no scheme/query/hash) resolve against the
 * current include() mount: `router.push("cart")` inside `include("/shop")`
 * navigates to `/shop/cart`. Under a parameterized mount
 * (`include("/:accountId", ...)`) the mount's params are filled from the
 * current route params: `router.push("issues")` at `/acme/board` navigates
 * to `/acme/issues`, and a missing mount param rejects the push/replace
 * promise with `Missing param` (a prefetch skips the target).
 * Absolute paths stay APP-absolute — unlike
 * basename, the mount is scoped, and absolute pushes legitimately target
 * outside it, so they are never auto-prefixed.
 *
 * @example
 * ```tsx
 * const router = useRouter();
 * router.push("/products");   // app-absolute
 * router.push("cart");        // mount-relative
 * router.replace("/login", { scroll: false });
 * router.prefetch("/dashboard");
 * router.back();
 * ```
 */
export function useRouter(): RouterInstance {
  const ctx = useContext(NavigationStoreContext);
  const mount = useMount();

  if (!ctx) {
    throw new Error("useRouter must be used within NavigationProvider");
  }

  // Stable reference per component: ctx is stable and mount is a static
  // property of the component's position in the tree; reads on each method
  // call pick up live basename values from the context (backed by a live
  // ref in NavigationProvider), so app-switch transitions are reflected
  // without recreating this object.
  return useMemo<RouterInstance>(() => {
    /** Prefix a root-relative path with basename if not already prefixed. */
    function withBasename(url: string): string {
      return prefixBasename(url, ctx!.basename);
    }

    /**
     * Resolve a navigation/prefetch target. RELATIVE paths — a leading word
     * character or `./`, never a scheme (`http:`, `mailto:`), query, or
     * hash form — join onto the include mount and then take the basename
     * pass like any root-relative path. Everything else passes through
     * unchanged.
     */
    function resolveTarget(url: string): string {
      const relative = url.startsWith("./") ? url.slice(2) : url;
      if (
        !/^[A-Za-z0-9]/.test(relative) ||
        /^[a-z][a-z0-9+.-]*:/i.test(relative)
      ) {
        return withBasename(url);
      }
      // The mount is the include()'s URL pattern: fill its params from the
      // committed params at call time (not render time, so this object stays
      // stable across navigations), as useHref does.
      return withBasename(
        href(
          `/${relative}` as ValidPaths,
          substitutePatternParams(
            mount,
            ctx!.eventController.getParams(),
            mount,
          ),
        ),
      );
    }

    // push/replace are async so a target that cannot resolve (a missing
    // mount param) rejects the returned promise instead of throwing.
    return {
      async push(url: string, options?: RouterNavigateOptions): Promise<void> {
        return ctx.navigate(resolveTarget(url), { ...options, replace: false });
      },

      async replace(
        url: string,
        options?: RouterNavigateOptions,
      ): Promise<void> {
        return ctx.navigate(resolveTarget(url), { ...options, replace: true });
      },

      refresh(): Promise<void> {
        return ctx.refresh();
      },

      prefetch(url: string, options?: { key?: ":source" }): void {
        const segmentState = ctx.store?.getSegmentState();
        if (segmentState) {
          let target: string;
          try {
            target = resolveTarget(url);
          } catch {
            // A prefetch is a hint: a target that cannot resolve (missing
            // mount param) is skipped; push/replace report the error.
            return;
          }
          prefetchDirect(
            target,
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
  }, [mount]);
}
