"use client";

import React, {
  forwardRef,
  useCallback,
  useContext,
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

import {
  hasPrefetch,
  markPrefetchInflight,
  clearPrefetchInflight,
  storePrefetchResponse,
} from "../prefetch-cache.js";

// Track prefetched URLs to avoid duplicate <link> elements (browser mode)
const prefetchedUrls = new Set<string>();

/**
 * Build an RSC partial URL for prefetching.
 */
function buildPrefetchUrl(url: string, segmentIds: string[]): URL {
  const targetUrl = new URL(url, window.location.origin);
  targetUrl.searchParams.set("_rsc_partial", "true");
  if (segmentIds.length > 0) {
    targetUrl.searchParams.set("_rsc_segments", segmentIds.join(","));
  }
  return targetUrl;
}

/**
 * Browser-mode prefetch: inject a <link rel="prefetch"> element.
 */
function prefetchUrlBrowser(url: string, segmentIds: string[]): void {
  if (prefetchedUrls.has(url)) return;
  prefetchedUrls.add(url);

  const targetUrl = buildPrefetchUrl(url, segmentIds);

  const link = document.createElement("link");
  link.rel = "prefetch";
  link.href = targetUrl.toString();
  link.as = "fetch";
  document.head.appendChild(link);
}
/**
 * Router-mode prefetch: fetch with low priority and store in prefetch cache.
 * Uses X-Rango-State header so the server adds Vary to prevent HTTP cache
 * collisions between prefetch and navigation requests.
 */
function prefetchUrlRouter(url: string, segmentIds: string[]): void {
  const targetUrl = buildPrefetchUrl(url, segmentIds);
  const key = targetUrl.pathname;
  if (hasPrefetch(key)) return;

  markPrefetchInflight(key);

  fetch(targetUrl.toString(), {
    priority: "low" as RequestPriority,
    headers: {
      "X-Rango-State": String(Date.now()),
    },
  })
    .then((response) => {
      if (response.ok || response.status === 204) {
        storePrefetchResponse(key, response.clone());
      }
    })
    .catch(() => {
      // Silently ignore prefetch failures
    })
    .finally(() => {
      clearPrefetchInflight(key);
    });
}

/**
 * Prefetch strategy for the Link component
 * - "hover": Prefetch on mouse enter (uses native <link rel="prefetch">)
 * - "viewport": Prefetch when link enters viewport (not yet implemented)
 * - "hybrid": Hover on desktop, viewport on mobile (not yet implemented)
 * - "none": No prefetching (default)
 */
export type PrefetchStrategy = "hover" | "viewport" | "hybrid" | "none";

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
    if (prefetch === "hover" && !isExternal && ctx?.store) {
      const segmentState = ctx.store.getSegmentState();
      if (ctx.prefetchMode === "browser") {
        prefetchUrlBrowser(to, segmentState.currentSegmentIds);
      } else {
        prefetchUrlRouter(to, segmentState.currentSegmentIds);
      }
    }
  }, [prefetch, to, isExternal, ctx]);

  return (
    <a
      ref={ref}
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
