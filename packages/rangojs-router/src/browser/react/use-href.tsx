"use client";

import { useCallback } from "react";
import { href, type ValidPaths } from "../../href-client.js";
import { substitutePatternParams } from "../../router/substitute-pattern-params.js";
import { useMount } from "./use-mount.js";
import { useParams } from "./use-params.js";

/**
 * Client-side hook for mount-aware URL resolution.
 *
 * Returns an href function that automatically prepends the current
 * include() mount prefix. Inside an include("/shop", ...) scope,
 * the returned function resolves local paths relative to /shop.
 *
 * Under a parameterized mount (`include("/:accountId", ...)`) the mount's
 * params are filled from the current route params, as `useReverse` does:
 * `href("/issues")` at `/acme/board` returns `/acme/issues`. A mount param
 * missing from the current match throws `Missing param` when the returned
 * function is called.
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
  // The filled mount (it starts with "/"), or the Missing param message. The
  // selector also runs in the params subscription, so it must not throw, and
  // a string lets useParams skip the re-render, and keeps the returned
  // function stable, unless the mount's own values change.
  const base = useParams((p) => {
    try {
      return substitutePatternParams(mount, p, mount);
    } catch (e) {
      return (e as Error).message;
    }
  });
  return useCallback(
    (path: `/${string}`) => {
      if (!base.startsWith("/")) throw new Error(base);
      return href(path as ValidPaths, base);
    },
    [base],
  );
}
