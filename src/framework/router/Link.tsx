/**
 * Global type-safe Link component using explicit route configuration
 */

"use client";

import React from "react";
import { buildPath } from "../rsc-router/route-paths";

// Import the global routes configuration
// This will be overridden by the user's routes.config.ts through path mapping
import { type AppRoutePaths, type AppRoutes } from "../../routes.config";

/**
 * Check if a route has parameters
 */
type HasRouteParams<T extends AppRoutePaths> = AppRoutes[T] extends null
  ? false
  : true;

/**
 * Get the parameter type for a route
 */
type RouteParamsFor<T extends AppRoutePaths> = AppRoutes[T] extends null
  ? never
  : AppRoutes[T];

/**
 * Props for the global type-safe Link component
 */
type GlobalTypedLinkProps<T extends AppRoutePaths = AppRoutePaths> = Omit<
  React.AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
> & {
  to: T;
  prefetch?: boolean;
} & (HasRouteParams<T> extends true
    ? { params: RouteParamsFor<T> }
    : { params?: never });

/**
 * Global type-safe Link component
 *
 * This component provides type-safe routing without requiring factory functions.
 * Routes are defined in routes.config.ts and automatically provide type safety.
 *
 * @example
 * import { GlobalTypedLink } from "rsc-router";
 *
 * <GlobalTypedLink to="/">Home</GlobalTypedLink>
 * <GlobalTypedLink to="/user/:id" params={{ id: "123" }}>User</GlobalTypedLink>
 */
export function Link<T extends AppRoutePaths>(props: GlobalTypedLinkProps<T>) {
  const { to, params, prefetch = false, ...restProps } = props;

  const href = buildPath(to as string, params || undefined);

  React.useEffect(() => {
    if (prefetch && href) {
      console.log(`[GlobalTypedLink] Prefetch enabled for ${href}`);
    }
  }, [prefetch, href]);

  return <a {...restProps} href={href} />;
}
