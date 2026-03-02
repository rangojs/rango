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
import {
  type LocationStateEntry,
  isLocationStateEntry,
  resolveLocationStateEntries,
} from "./location-state.js";

/**
 * State value or getter function for just-in-time state resolution (legacy)
 */
export type StateOrGetter<T = unknown> = T | (() => T);

/**
 * State prop type for Link component
 * - LocationStateEntry[]: Type-safe state entries (always lazy)
 * - StateOrGetter: Legacy format for backwards compatibility
 */
export type LinkState = LocationStateEntry[] | StateOrGetter;

import { prefetchDirect, prefetchQueued } from "../prefetch-fetch.js";
import {
  observeForPrefetch,
  unobserveForPrefetch,
} from "../prefetch-observer.js";

// Touch device detection for hybrid strategy.
// Checked once at module load (Link.tsx is "use client", runs only in browser).
const isTouchDevice =
  typeof window !== "undefined" && window.matchMedia("(hover: none)").matches;

/**
 * Prefetch strategy for the Link component
 * - "hover": Prefetch on mouse enter (direct, no queue)
 * - "viewport": Prefetch when link enters viewport (queued, waits for idle)
 * - "render": Prefetch on component mount regardless of visibility (queued, waits for idle)
 * - "hybrid": Hover on pointer devices, viewport on touch devices
 * - "none": No prefetching (default)
 */
export type PrefetchStrategy =
  | "hover"
  | "viewport"
  | "render"
  | "hybrid"
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
   * const ProductState = createLocationState((p: Product) => ({ name: p.name }));
   * <Link to="/product" state={[ProductState(product)]}>View</Link>
   *
   * // Multiple typed states
   * <Link to="/checkout" state={[ProductState(p), CartState(c)]}>Checkout</Link>
   *
   * // Legacy: static state
   * <Link to="/product" state={{ from: "list" }}>View</Link>
   *
   * // Legacy: dynamic state (called at click time)
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

  // Resolve hybrid: viewport on touch devices, hover on pointer devices
  const resolvedStrategy =
    prefetch === "hybrid" ? (isTouchDevice ? "viewport" : "hover") : prefetch;

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

      // Prevent default and use SPA navigation
      e.preventDefault();
      // Stop propagation to prevent link-interceptor from also handling this
      e.stopPropagation();

      if (ctx?.navigate) {
        // Resolve state just-in-time based on format
        let resolvedState: unknown;
        const currentState = stateRef.current;

        if (
          Array.isArray(currentState) &&
          currentState.length > 0 &&
          isLocationStateEntry(currentState[0])
        ) {
          // Type-safe LocationStateEntry[] - resolve each entry into keyed object
          resolvedState = resolveLocationStateEntries(
            currentState as LocationStateEntry[],
          );
        } else if (typeof currentState === "function") {
          // Legacy getter function
          resolvedState = currentState();
        } else {
          // Legacy static value
          resolvedState = currentState;
        }

        ctx.navigate(to, { replace, scroll, state: resolvedState });
      }
    },
    [to, isExternal, reloadDocument, replace, scroll, ctx, onClick],
  );

  const handleMouseEnter = useCallback(() => {
    if (resolvedStrategy === "hover" && !isExternal && ctx?.store) {
      const segmentState = ctx.store.getSegmentState();
      prefetchDirect(to, segmentState.currentSegmentIds, ctx.version);
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

    const triggerPrefetch = () => {
      if (cancelled) return;
      const segmentState = ctx.store.getSegmentState();
      prefetchQueued(to, segmentState.currentSegmentIds, ctx.version);
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
      observeForPrefetch(element, () => {
        scheduleWhenIdle(triggerPrefetch);
      });
    }

    return () => {
      cancelled = true;
      unsubIdle?.();
      if (isViewport && internalRef.current) {
        unobserveForPrefetch(internalRef.current);
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
      {...props}
    >
      <LinkContext.Provider value={to}>{children}</LinkContext.Provider>
    </a>
  );
});
