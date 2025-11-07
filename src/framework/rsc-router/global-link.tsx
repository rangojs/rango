/**
 * Global type-safe Link component that uses module augmentation
 *
 * Users define their routes by augmenting the AppRoutes interface
 */

'use client';

import React from 'react';
import { buildPath } from './route-paths';

/**
 * Global interface for app routes - augment this in your app
 *
 * @example
 * // In your app's global.d.ts or routes file:
 * declare module "rsc-router" {
 *   interface AppRoutes {
 *     "/": never;
 *     "/about": never;
 *     "/user/:id": { id: string };
 *     "/post/:postId/comments/:commentId": { postId: string; commentId: string };
 *   }
 * }
 */
export interface AppRoutes {
  // This will be augmented by the user's app
  // Format: [path: string]: ParamsType | never
}

/**
 * Extract valid route paths from AppRoutes
 */
type AppRoutePaths = keyof AppRoutes;

/**
 * Get params for a specific route
 */
type RouteParamsFor<T extends AppRoutePaths> = AppRoutes[T];

/**
 * Check if a route has params
 */
type HasRouteParams<T extends AppRoutePaths> = AppRoutes[T] extends never ? false : true;

/**
 * Props for the global Link component
 */
type GlobalLinkProps<T extends AppRoutePaths = AppRoutePaths> =
  Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
    to: T;
    prefetch?: boolean;
  } & (HasRouteParams<T> extends true
    ? { params: RouteParamsFor<T> }
    : { params?: never });

/**
 * Global type-safe Link component
 *
 * This automatically uses the routes defined in your AppRoutes augmentation
 *
 * @example
 * import { Link } from "rsc-router";
 *
 * <Link to="/">Home</Link>
 * <Link to="/user/:id" params={{ id: "123" }}>User</Link>
 */
export function Link<T extends AppRoutePaths>(props: GlobalLinkProps<T>) {
  const { to, params, prefetch = false, ...restProps } = props;

  const href = buildPath(to as string, params);

  React.useEffect(() => {
    if (prefetch && href) {
      console.log(`[Link] Prefetch enabled for ${href}`);
    }
  }, [prefetch, href]);

  return <a {...restProps} href={href} />;
}

/**
 * Re-export for backward compatibility
 */
export { Link as GlobalLink };