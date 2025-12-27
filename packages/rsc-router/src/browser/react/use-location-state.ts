"use client";

import { useState, useEffect } from "react";

/**
 * Hook to access the current location state from history.state
 *
 * Returns the state passed to navigate() or Link's state prop.
 * Updates automatically on browser back/forward.
 *
 * @example
 * ```tsx
 * // Navigate with state
 * <Link to="/product/123" state={{ from: "list" }}>View</Link>
 *
 * // Or programmatically
 * navigate("/product/123", { state: { from: "list" } });
 *
 * // Read state in component
 * const locationState = useLocationState<{ from?: string }>();
 * if (locationState?.from === "list") {
 *   // Show back to list button
 * }
 * ```
 */
export function useLocationState<T = unknown>(): T | undefined {
  const [state, setState] = useState<T | undefined>(() => {
    if (typeof window === "undefined") return undefined;
    return window.history.state?.state as T | undefined;
  });

  useEffect(() => {
    const handlePopstate = () => {
      setState(window.history.state?.state as T | undefined);
    };
    window.addEventListener("popstate", handlePopstate);
    return () => window.removeEventListener("popstate", handlePopstate);
  }, []);

  return state;
}
