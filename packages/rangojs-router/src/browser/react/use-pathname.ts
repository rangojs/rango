"use client";

import { useContext, useState, useEffect, useRef } from "react";
import { NavigationStoreContext } from "./context.js";
import { getSsrPathname } from "./use-segments.js";

/**
 * Hook to access the current pathname.
 *
 * Returns the committed pathname string (excludes search params and hash).
 * Updates when navigation completes, not during pending navigation.
 *
 * @example
 * ```tsx
 * const pathname = usePathname();
 * // "/products/123"
 * ```
 */
export function usePathname(): string {
  const ctx = useContext(NavigationStoreContext);

  const [pathname, setPathname] = useState<string>(() => {
    if (typeof document === "undefined" || !ctx) {
      return getSsrPathname();
    }
    return (ctx.eventController.getState().location as URL).pathname;
  });

  const prevPathname = useRef(pathname);

  useEffect(() => {
    if (!ctx) return;

    const update = () => {
      const next = (ctx.eventController.getState().location as URL).pathname;
      if (next !== prevPathname.current) {
        prevPathname.current = next;
        setPathname(next);
      }
    };

    update();

    return ctx.eventController.subscribe(update);
  }, []);

  return pathname;
}
