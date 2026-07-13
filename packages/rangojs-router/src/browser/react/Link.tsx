"use client";

import React, {
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from "react";
import { NavigationStoreContext } from "./context.js";
import { LinkContext } from "./use-link-status.js";
import type { NavigateOptions } from "../types.js";
import { isHashOnlyNavigation } from "../link-interceptor.js";
import { subscribeToLocationChange } from "../event-controller.js";
import {
  isLocationStateEntry,
  type LocationStateEntry,
  resolveLocationStateEntries,
} from "./location-state.js";

/**
 * State prop type for Link component.
 * - LocationStateEntry[]: Type-safe state entries via createLocationState()
 * - StateOrGetter: Plain state object or click-time getter function
 * - Record<string, unknown>: Plain state object passed to history.pushState
 */
export type StateOrGetter<T = unknown> = T | (() => T);

export type LinkState =
  | LocationStateEntry[]
  | StateOrGetter<Record<string, unknown>>;

import {
  prefetchDirect,
  prefetchQueued,
  schedulePrefetchWhenRouterIdle,
} from "../prefetch/loader.js";
import { observeForPrefetch } from "../prefetch/observer.js";
import {
  getDefaultPrefetchStrategy,
  resolveAdaptiveStrategy,
} from "../prefetch/default-strategy.js";
import { getAppVersion } from "../app-version.js";
import type { PrefetchStrategy } from "../../router/prefetch-default.js";

// The PrefetchStrategy union is defined in router/prefetch-default.ts (both
// the server-side option resolver and this client seat consume it); re-export
// so the public `PrefetchStrategy` import path via client.tsx is unchanged.
export type { PrefetchStrategy } from "../../router/prefetch-default.js";
export { resolveAdaptiveStrategy } from "../prefetch/default-strategy.js";

/**
 * Link component props
 */
export interface LinkProps extends Omit<
  React.AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
> {
  /**
   * The URL to navigate to (typically from router.reverse())
   */
  to: string;
  /**
   * Replace current history entry instead of pushing
   */
  replace?: boolean;
  /**
   * Scroll to top after navigation (default: true)
   */
  scroll?: boolean;
  /**
   * Force full document navigation instead of SPA
   */
  reloadDocument?: boolean;
  /**
   * Whether to revalidate server data on navigation.
   * Set to `false` to skip the RSC server fetch and only update the URL.
   *
   * Only takes effect when the pathname stays the same (search param / hash changes).
   * If the pathname changes, this option is ignored and a full navigation occurs.
   *
   * @default true
   */
  revalidate?: boolean;
  /**
   * Prefetch strategy for the link destination. When omitted, falls back to
   * the router-wide default (`createRouter({ defaultPrefetch })`: `"none"` in
   * development, `"viewport"` in production). An explicit value always wins
   * over the router default, including `"none"` to opt a single Link out.
   *
   * @default the router's environment-aware `defaultPrefetch`
   */
  prefetch?: PrefetchStrategy;
  /**
   * Opt-in override for the prefetch cache scope.
   *
   * The default cache is source-agnostic: one shared entry per target,
   * keyed on Rango state + target URL. This is correct for routes whose
   * response shape doesn't depend on where the user navigates from.
   *
   * Set `":source"` when this Link's response would legitimately differ
   * based on the source page — typically when the target route (or one
   * of its layouts) uses a custom `revalidate()` handler that reads
   * `currentUrl` / `currentParams`, and the wildcard entry would
   * therefore serve the wrong diff to a navigation from a different
   * source.
   *
   * Intercept responses are auto-scoped to the source via a server-side
   * tag, so `":source"` is only needed for custom revalidation logic.
   *
   * @example
   * ```tsx
   * // Route uses a `revalidate()` that branches on currentUrl — opt in
   * // so prefetches don't bleed across source pages.
   * <Link to="/dashboard" prefetch="hover" prefetchKey=":source" />
   * ```
   */
  prefetchKey?: ":source";
  /**
   * State to pass to history.pushState/replaceState.
   * Accessible via useLocationState() hook.
   *
   * @example
   * ```tsx
   * // Type-safe state with createLocationState (recommended)
   * const ProductState = createLocationState<{ name: string; price: number }>();
   * <Link to="/product" state={[ProductState({ name: product.name, price: product.price })]}>
   *   View
   * </Link>
   *
   * // Type-safe just-in-time state (getter called at click time, not render time).
   * // Must be in a client component -- getter can't cross the RSC boundary.
   * <Link
   *   to="/product"
   *   state={[ProductState(() => ({ name: product.name, price: product.price }))]}
   * >
   *   View
   * </Link>
   *
   * // Multiple typed states
   * <Link to="/checkout" state={[ProductState({ name: p.name, price: p.price }), CartState(c)]}>
   *   Checkout
   * </Link>
   *
   * // Plain static state
   * <Link to="/product" state={{ from: "list" }}>View</Link>
   *
   * // Plain just-in-time state (called at click time, requires client component)
   * <Link to="/product" state={() => ({ scrollY: window.scrollY })}>View</Link>
   * ```
   */
  state?: LinkState;
  children: React.ReactNode;
}

/**
 * Check if URL is external (different origin)
 */
function isExternalUrl(href: string): boolean {
  // Protocol-relative URLs
  if (href.startsWith("//")) return true;

  // Absolute URLs
  if (href.startsWith("http://") || href.startsWith("https://")) {
    try {
      return new URL(href).origin !== window.location.origin;
    } catch {
      return false;
    }
  }

  // Special protocols (mailto, tel, etc.)
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return true;
  }

  return false;
}

/**
 * Type-safe Link component for SPA navigation
 *
 * Works with router.reverse() for type-safe URLs:
 * ```tsx
 * <Link to={router.reverse("shop.products.detail", { slug: "my-product" })}>
 *   View Product
 * </Link>
 * ```
 *
 * Also supports regular URLs:
 * ```tsx
 * <Link to="/about">About</Link>
 * <Link to="https://example.com">External</Link>
 * ```
 */
export const Link: ForwardRefExoticComponent<
  LinkProps & RefAttributes<HTMLAnchorElement>
> = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  {
    to,
    replace = false,
    scroll = true,
    reloadDocument = false,
    revalidate,
    prefetch,
    prefetchKey,
    state,
    children,
    onClick,
    ...props
  },
  ref,
) {
  const ctx = useContext(NavigationStoreContext);
  const isExternal = isExternalUrl(to);

  // Auto-prefix with basename for app-local paths.
  // Skip if external, already prefixed, or not a root-relative path.
  const resolvedTo = useMemo(() => {
    if (isExternal) return to;
    const bn = ctx?.basename;
    if (!bn || !to.startsWith("/") || to.startsWith(bn + "/") || to === bn)
      return to;
    return to === "/" ? bn : bn + to;
  }, [to, isExternal, ctx?.basename]);

  // No explicit `prefetch` prop: fall back to the router-wide default
  // (server-resolved, applied at browser init — before hydration, so this
  // render-time read never races the metadata). Adaptive reads the current
  // input capability rather than a module-load snapshot.
  const resolvedStrategy = resolveAdaptiveStrategy(
    prefetch ?? ctx?.defaultPrefetch ?? getDefaultPrefetchStrategy(),
  );

  // Internal ref for viewport observation; merge with forwarded ref
  const internalRef = useRef<HTMLAnchorElement | null>(null);
  const setRef = useCallback(
    (node: HTMLAnchorElement | null) => {
      internalRef.current = node;
      if (typeof ref === "function") {
        ref(node);
      } else if (ref) {
        (ref as React.MutableRefObject<HTMLAnchorElement | null>).current =
          node;
      }
    },
    [ref],
  );

  // Use ref to always get the latest state/getter without adding to useCallback deps
  // This enables just-in-time state resolution without causing re-renders
  const stateRef = useRef(state);
  stateRef.current = state;

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      // Call user's onClick handler first
      onClick?.(e);

      // If user prevented default, respect that
      if (e.defaultPrevented) return;

      // External links - let browser handle normally
      if (isExternal) return;

      // Force document navigation if requested
      if (reloadDocument) return;

      // Allow modifier keys for opening in new tab/window
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

      // Check for download attribute
      if ((e.currentTarget as HTMLAnchorElement).hasAttribute("download"))
        return;

      // Check for target attribute
      const target = (e.currentTarget as HTMLAnchorElement).target;
      if (target && target !== "_self") return;

      // Hash-only navigation: let the browser handle anchor scrolling natively.
      if (isHashOnlyNavigation(e.currentTarget as HTMLAnchorElement)) {
        return;
      }

      // No navigation context (outside provider): fall back to native navigation.
      if (!ctx?.navigate) {
        return;
      }

      // Prevent default and use SPA navigation
      e.preventDefault();
      // Stop propagation to prevent link-interceptor from also handling this
      e.stopPropagation();

      const currentState = stateRef.current;
      let resolvedState: unknown;

      if (
        Array.isArray(currentState) &&
        currentState.length > 0 &&
        isLocationStateEntry(currentState[0])
      ) {
        resolvedState = resolveLocationStateEntries(
          currentState as LocationStateEntry[],
        );
      } else if (typeof currentState === "function") {
        resolvedState = currentState();
      } else if (currentState != null) {
        resolvedState = currentState;
      }

      ctx.navigate(resolvedTo, {
        replace,
        scroll,
        state: resolvedState,
        revalidate,
      });
    },
    [
      resolvedTo,
      isExternal,
      reloadDocument,
      replace,
      scroll,
      revalidate,
      ctx,
      onClick,
    ],
  );

  const handleMouseEnter = useCallback(() => {
    if (
      (resolvedStrategy === "hover" || resolvedStrategy === "viewport") &&
      !isExternal &&
      ctx?.store
    ) {
      // For "hover", this is the primary prefetch trigger.
      // For "viewport", this upgrades/prioritizes a potentially queued
      // prefetch — prefetchDirect bypasses the queue, and hasPrefetch
      // deduplicates if the viewport prefetch already completed.
      const segmentState = ctx.store.getSegmentState();
      prefetchDirect(
        resolvedTo,
        segmentState.currentSegmentIds,
        getAppVersion(),
        ctx.store.getRouterId?.(),
        prefetchKey,
      );
    }
  }, [resolvedStrategy, resolvedTo, isExternal, ctx, prefetchKey]);

  // Viewport/render prefetch: waits for idle before starting,
  // uses concurrency-limited queue to avoid flooding.
  useEffect(() => {
    if (isExternal || !ctx?.store) return;
    const isViewport = resolvedStrategy === "viewport";
    const isRender = resolvedStrategy === "render";
    if (!isViewport && !isRender) return;

    const armPrefetch = (): (() => void) => {
      let cancelled = false;
      let unsubIdle: (() => void) | undefined;
      let stopObserving: (() => void) | undefined;

      const triggerPrefetch = () => {
        if (cancelled) return;
        const segmentState = ctx.store.getSegmentState();
        prefetchQueued(
          resolvedTo,
          segmentState.currentSegmentIds,
          getAppVersion(),
          ctx.store.getRouterId?.(),
          prefetchKey,
        );
      };

      if (isRender) {
        unsubIdle = schedulePrefetchWhenRouterIdle(
          ctx.eventController,
          triggerPrefetch,
        );
      } else {
        const element = internalRef.current;
        if (element) {
          stopObserving = observeForPrefetch(element, () => {
            unsubIdle = schedulePrefetchWhenRouterIdle(
              ctx.eventController,
              triggerPrefetch,
            );
          });
        }
      }

      return () => {
        cancelled = true;
        unsubIdle?.();
        stopObserving?.();
      };
    };

    let disarmPrefetch = armPrefetch();
    const unsubscribeLocation = subscribeToLocationChange(
      ctx.eventController,
      () => {
        disarmPrefetch();
        disarmPrefetch = armPrefetch();
      },
    );

    return () => {
      unsubscribeLocation();
      disarmPrefetch();
    };
  }, [resolvedStrategy, resolvedTo, isExternal, ctx, prefetchKey]);

  return (
    <a
      ref={setRef}
      href={resolvedTo}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      data-link-component
      data-external={isExternal ? "" : undefined}
      data-scroll={scroll === false ? "false" : undefined}
      data-replace={replace ? "true" : undefined}
      data-revalidate={revalidate === false ? "false" : undefined}
      {...props}
    >
      <LinkContext.Provider value={resolvedTo}>{children}</LinkContext.Provider>
    </a>
  );
});
