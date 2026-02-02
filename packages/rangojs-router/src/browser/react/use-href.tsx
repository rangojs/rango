"use client";

import { createContext, useContext, type Context } from "react";
import { createHref } from "../../href.js";

/**
 * Context value for href resolution
 */
export interface HrefContextValue {
  /** Route map: route name -> URL pattern */
  routeMap: Record<string, string>;
  /** Current matched route name (includes name prefix from include()) */
  routeName?: string;
}

/**
 * Context for href resolution (route map and current route name)
 * Populated from RSC metadata during hydration/navigation
 */
export const HrefContext: Context<HrefContextValue | null> =
  createContext<HrefContextValue | null>(null);

/**
 * Resolution priority for href:
 * 1. Path-based (/blog/:slug) → Use directly
 * 2. Absolute name (shop.cart) → Global lookup (has dot separator)
 * 3. Local name (index) → Prepend current name prefix, then lookup
 */
function resolveRouteName(
  name: string,
  routeMap: Record<string, string>,
  currentRoutePrefix?: string
): string | undefined {
  // 1. Path-based - starts with /
  if (name.startsWith("/")) {
    return name;
  }

  // 2. Absolute name - already has a dot (e.g., "shop.cart")
  if (name.includes(".")) {
    return routeMap[name];
  }

  // 3. Local name - try with current prefix first, then fall back to direct lookup
  if (currentRoutePrefix) {
    // Extract the prefix from current route name
    // e.g., "blog.posts.detail" → prefix is "blog.posts"
    const lastDot = currentRoutePrefix.lastIndexOf(".");
    const prefix = lastDot > 0 ? currentRoutePrefix.substring(0, lastDot) : currentRoutePrefix;

    // Try prefixed name
    const prefixedName = `${prefix}.${name}`;
    if (routeMap[prefixedName] !== undefined) {
      return routeMap[prefixedName];
    }

    // If current route is a nested include, try parent prefixes
    // e.g., for "blog.posts.detail", try "blog.posts.index", then "blog.index"
    let currentPrefix = prefix;
    while (currentPrefix.includes(".")) {
      const parentDot = currentPrefix.lastIndexOf(".");
      currentPrefix = currentPrefix.substring(0, parentDot);
      const parentPrefixedName = `${currentPrefix}.${name}`;
      if (routeMap[parentPrefixedName] !== undefined) {
        return routeMap[parentPrefixedName];
      }
    }
  }

  // Fall back to direct lookup (route without prefix)
  return routeMap[name];
}

/**
 * Type for href function returned by useHref
 */
export type HrefFn = {
  /**
   * Generate a URL from a route name
   *
   * @param name - Route name (local or absolute) or path-based URL
   * @param params - Optional params for dynamic segments
   * @returns The resolved URL
   *
   * @example
   * ```tsx
   * const href = useHref();
   *
   * // Local name (resolved with current prefix)
   * href("index")         // → "/blog" (if inside blog patterns)
   * href("post", { slug: "hello" }) // → "/blog/hello"
   *
   * // Absolute name (direct lookup)
   * href("shop.cart")     // → "/shop/cart"
   *
   * // Path-based (used directly)
   * href("/about")        // → "/about"
   * ```
   */
  (name: string, params?: Record<string, string>): string;
};

/**
 * Client-side hook for resolving route names with current name prefix.
 *
 * Resolution priority:
 * 1. Path-based (`/blog/:slug`) → Use directly
 * 2. Absolute name (`shop.cart`) → Global lookup (contains dot)
 * 3. Local name (`index`) → Prepend current name prefix, then lookup
 *
 * @returns A function to generate URLs from route names
 *
 * @example
 * ```tsx
 * "use client";
 * import { useHref } from "@rangojs/router/client";
 *
 * function BlogNav() {
 *   const href = useHref();
 *
 *   return (
 *     <>
 *       {/* Local names - resolved with current name prefix *\/}
 *       <Link href={href("index")}>Blog Home</Link>
 *       <Link href={href("post", { slug: "hello" })}>Post</Link>
 *
 *       {/* Absolute names - explicit prefix *\/}
 *       <Link href={href("shop.cart")}>Cart</Link>
 *
 *       {/* Path-based - always works *\/}
 *       <Link href={href("/about")}>About</Link>
 *     </>
 *   );
 * }
 * ```
 */
export function useHref(): HrefFn {
  const context = useContext(HrefContext);

  if (!context) {
    // Return a function that warns and returns the name as-is
    return (name: string, _params?: Record<string, string>) => {
      if (process.env.NODE_ENV !== "production") {
        console.warn(
          "[useHref] HrefContext not found. Make sure HrefProvider is mounted. Returning name as-is."
        );
      }
      return name;
    };
  }

  const { routeMap, routeName } = context;

  return (name: string, params?: Record<string, string>) => {
    // Path-based - return directly (optionally with param substitution)
    if (name.startsWith("/")) {
      if (params) {
        // Substitute params in path-based URL
        return name.replace(/:([^/]+)/g, (_, key) => {
          const value = params[key];
          if (value === undefined) {
            throw new Error(`Missing param "${key}" for path "${name}"`);
          }
          return encodeURIComponent(value);
        });
      }
      return name;
    }

    // Resolve route name
    const pattern = resolveRouteName(name, routeMap, routeName);

    if (pattern === undefined) {
      throw new Error(
        `Unknown route: "${name}"${routeName ? ` (current route: ${routeName})` : ""}`
      );
    }

    // If no params, return pattern directly
    if (!params) {
      return pattern;
    }

    // Substitute params
    return pattern.replace(/:([^/]+)/g, (_, key) => {
      const value = params[key];
      if (value === undefined) {
        throw new Error(`Missing param "${key}" for route "${name}"`);
      }
      return encodeURIComponent(value);
    });
  };
}

/**
 * Provider component for href context
 * Used internally by NavigationProvider to pass route map from RSC metadata
 */
export function HrefProvider({
  routeMap,
  routeName,
  children,
}: {
  routeMap: Record<string, string>;
  routeName?: string;
  children: React.ReactNode;
}) {
  return (
    <HrefContext.Provider value={{ routeMap, routeName }}>
      {children}
    </HrefContext.Provider>
  );
}
