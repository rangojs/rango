"use client";

import React, { forwardRef, useCallback, useContext, type ForwardRefExoticComponent, type RefAttributes } from "react";
import { NavigationStoreContext } from "./context.js";
import type { NavigateOptions } from "../types.js";

/**
 * Prefetch strategy for the Link component
 * Currently stubbed for future implementation
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
   * Prefetch strategy (for future implementation)
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

  return (
    <a ref={ref} href={to} onClick={handleClick} {...props}>
      {children}
    </a>
  );
});
