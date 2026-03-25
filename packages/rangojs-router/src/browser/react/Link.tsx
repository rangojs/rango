"use client";

import React, {
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from "react";
import { NavigationStoreContext } from "./context.js";
import { LinkContext } from "./use-link-status.js";
import type { NavigateOptions } from "../types.js";
import { isHashOnlyNavigation } from "../link-interceptor.js";
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

import { prefetchDirect, prefetchQueued } from "../prefetch/fetch.js";
import { getAppVersion } from "../app-version.js";
import {
  observeForPrefetch,
  unobserveForPrefetch,
} from "../prefetch/observer.js";

// Touch device detection for adaptive strategy.
// Checked once at module load (Link.tsx is "use client", runs only in browser).
const isTouchDevice =
  typeof window !== "undefined" && window.matchMedia("(hover: none)").matches;

/**
 * Prefetch strategy for the Link component
 * - "hover": Prefetch on mouse enter (direct, no queue)
 * - "viewport": Prefetch when link enters viewport (queued, waits for idle)
 * - "render": Prefetch on component mount regardless of visibility (queued, waits for idle)
 * - "adaptive": Hover on pointer devices, viewport on touch devices
 * - "none": No prefetching (default)
 */
export type PrefetchStrategy =
  | "hover"
  | "viewport"
  | "render"
  | "adaptive"
  | "none";

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
   * Prefetch strategy for the link destination
   * @default "none"
   */
  prefetch?: PrefetchStrategy;
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
    prefetch = "none",
    state,
    children,
    onClick,
    ...props
  },
  ref,
) {
  const ctx = useContext(NavigationStoreContext);
  const isExternal = isExternalUrl(to);

  // Resolve adaptive: viewport on touch devices, hover on pointer devices
  const resolvedStrategy =
    prefetch === "adaptive" ? (isTouchDevice ? "viewport" : "hover") : prefetch;

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

      ctx.navigate(to, { replace, scroll, state: resolvedState, revalidate });
    },
    [to, isExternal, reloadDocument, replace, scroll, revalidate, ctx, onClick],
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
      prefetchDirect(to, segmentState.currentSegmentIds, getAppVersion());
    }
  }, [resolvedStrategy, to, isExternal, ctx]);

  // Viewport/render prefetch: waits for idle before starting,
  // uses concurrency-limited queue to avoid flooding.
  useEffect(() => {
    if (isExternal || !ctx?.store) return;
    const isViewport = resolvedStrategy === "viewport";
    const isRender = resolvedStrategy === "render";
    if (!isViewport && !isRender) return;

    let cancelled = false;
    let unsubIdle: (() => void) | undefined;
    let observedElement: Element | null = null;

    const triggerPrefetch = () => {
      if (cancelled) return;
      const segmentState = ctx.store.getSegmentState();
      prefetchQueued(to, segmentState.currentSegmentIds, getAppVersion());
    };

    // Schedule prefetch only when the app is idle (no navigation/streaming).
    // This avoids competing with hydration and active navigation fetches.
    const scheduleWhenIdle = (callback: () => void) => {
      const state = ctx.eventController.getState();
      if (state.state === "idle" && !state.isStreaming) {
        callback();
        return;
      }
      const unsub = ctx.eventController.subscribe(() => {
        const s = ctx.eventController.getState();
        if (s.state === "idle" && !s.isStreaming) {
          unsub();
          callback();
        }
      });
      unsubIdle = unsub;
    };

    if (isRender) {
      scheduleWhenIdle(triggerPrefetch);
    } else if (isViewport) {
      const element = internalRef.current;
      if (!element) return;
      observedElement = element;
      observeForPrefetch(element, () => {
        scheduleWhenIdle(triggerPrefetch);
      });
    }

    return () => {
      cancelled = true;
      unsubIdle?.();
      if (isViewport && observedElement) {
        unobserveForPrefetch(observedElement);
      }
    };
  }, [resolvedStrategy, to, isExternal, ctx]);

  return (
    <a
      ref={setRef}
      href={to}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      data-link-component
      data-external={isExternal ? "" : undefined}
      data-scroll={scroll === false ? "false" : undefined}
      data-replace={replace ? "true" : undefined}
      data-revalidate={revalidate === false ? "false" : undefined}
      {...props}
    >
      <LinkContext.Provider value={to}>{children}</LinkContext.Provider>
    </a>
  );
});
