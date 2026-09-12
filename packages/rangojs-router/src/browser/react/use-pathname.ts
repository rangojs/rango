"use client";

import { useContext, useState, useEffect, useRef } from "react";
import { NavigationStoreContext } from "./context.js";
import { OptimisticLocationContext } from "../../client-urls/optimistic-location.js";

/**
 * Hook to access the current pathname.
 *
 * Returns the committed pathname string (excludes search params and hash).
 * Updates when navigation completes, not during pending navigation — except
 * inside an optimistically rendered clientUrls() destination, where it
 * reports THAT route's pathname (see OptimisticLocationContext).
 *
 * @example
 * ```tsx
 * const pathname = usePathname();
 * // "/products/123"
 * ```
 */
export function usePathname(): string {
  const ctx = useContext(NavigationStoreContext);
  const optimistic = useContext(OptimisticLocationContext);

  const [pathname, setPathname] = useState<string>(() => {
    if (!ctx) {
      return "/";
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

  return optimistic ? optimistic.pathname : pathname;
}
