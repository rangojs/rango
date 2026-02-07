"use client";

import { href, type ValidPaths } from "../../href-client.js";
import { useMount } from "./use-mount.js";

/**
 * Client-side hook for mount-aware URL resolution.
 *
 * Returns an href function that automatically prepends the current
 * include() mount prefix. Inside an include("/shop", ...) scope,
 * the returned function resolves local paths relative to /shop.
 *
 * For absolute paths (outside the current mount), use the bare
 * href() function directly instead.
 *
 * @returns A function that prepends the mount prefix to paths
 *
 * @example
 * ```tsx
 * "use client";
 * import { useHref, href } from "@rangojs/router/client";
 *
 * // Inside include("/shop", shopPatterns)
 * function ShopNav() {
 *   const href = useHref();
 *
 *   return (
 *     <>
 *       {// Local paths - auto-prefixed with /shop}
 *       <Link to={href("/cart")}>Cart</Link>
 *       <Link to={href("/product/widget")}>Widget</Link>
 *     </>
 *   );
 * }
 * ```
 */
export function useHref(): (path: `/${string}`) => string {
  const mount = useMount();
  return (path: `/${string}`) => href(path as ValidPaths, mount);
}
