"use client";

import React, { forwardRef, useCallback, useContext, type ForwardRefExoticComponent, type RefAttributes } from "react";
import { NavigationStoreContext } from "./context.js";
import type { NavigateOptions } from "../types.js";

// Track prefetched URLs to avoid duplicate <link> elements
const prefetchedUrls = new Set<string>();

/**
 * Inject a <link rel="prefetch"> element into the document head
 * for the given URL with RSC partial request parameters.
 */
function prefetchUrl(url: string, segmentIds: string[]): void {
  if (prefetchedUrls.has(url)) return;
  prefetchedUrls.add(url);

  // Build RSC partial URL with segment IDs
  const targetUrl = new URL(url, window.location.origin);
  targetUrl.searchParams.set("_rsc_partial", "true");
  if (segmentIds.length > 0) {
    targetUrl.searchParams.set("_rsc_segments", segmentIds.join(","));
  }

  // Inject <link rel="prefetch"> into head
  const link = document.createElement("link");
  link.rel = "prefetch";
  link.href = targetUrl.toString();
  link.as = "fetch";
  document.head.appendChild(link);
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
export interface LinkProps
  extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  /**
   * The URL to navigate to (typically from router.href())
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
 * Works with router.href() for type-safe URLs:
 * ```tsx
 * <Link to={router.href("shop.products.detail", { slug: "my-product" })}>
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
export const Link: ForwardRefExoticComponent<LinkProps & RefAttributes<HTMLAnchorElement>> = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  {
    to,
    replace = false,
    scroll = true,
    reloadDocument = false,
    prefetch = "none",
    children,
    onClick,
    ...props
  },
  ref
) {
  const ctx = useContext(NavigationStoreContext);
  const isExternal = isExternalUrl(to);

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

      if (ctx?.navigate) {
        ctx.navigate(to, { replace, scroll } as NavigateOptions);
      }
    },
    [to, isExternal, reloadDocument, replace, scroll, ctx, onClick]
  );

  const handleMouseEnter = useCallback(() => {
    if (prefetch === "hover" && !isExternal && ctx?.store) {
      const segmentState = ctx.store.getSegmentState();
      prefetchUrl(to, segmentState.currentSegmentIds);
    }
  }, [prefetch, to, isExternal, ctx]);

  return (
    <a ref={ref} href={to} onClick={handleClick} onMouseEnter={handleMouseEnter} {...props}>
      {children}
    </a>
  );
});
