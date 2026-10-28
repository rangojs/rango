"use client";

import { useContext } from "react";
import { useUrlValue } from "./use-route-state.js";
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
  const optimistic = useContext(OptimisticLocationContext);
  const pathname = useUrlValue((route) => route.location.pathname, Object.is);
  return optimistic ? optimistic.pathname : pathname;
}
