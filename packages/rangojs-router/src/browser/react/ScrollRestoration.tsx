"use client";

import { useEffect } from "react";
import { initScrollRestoration } from "../scroll-restoration.js";

/**
 * Props for ScrollRestoration component
 */
export interface ScrollRestorationProps {
  /**
   * Custom function to determine the scroll restoration key.
   * By default, uses a unique key per history entry (location.key).
   *
   * Return location.pathname to restore scroll based on path
   * (useful for keeping scroll position on the same page).
   *
   * Provide a stable reference: a module-level function or one wrapped in
   * useCallback. The init effect re-runs when getKey's identity changes, and
   * teardown clears in-memory scroll positions — a fresh inline arrow on every
   * parent render would discard unpersisted positions mid-session.
   *
   * @example
   * ```tsx
   * // Stable module-level getKey (recommended)
   * const byPathname = (location) => location.pathname;
   *
   * // Restore based on pathname (same URL = same scroll)
   * <ScrollRestoration getKey={byPathname} />
   *
   * // Restore based on unique history entry (default)
   * // <ScrollRestoration /> — omit getKey to use location.key
   * ```
   */
  getKey?: (location: {
    pathname: string;
    search: string;
    hash: string;
    key: string;
  }) => string;
}

/**
 * ScrollRestoration component
 *
 * Enables scroll position restoration across navigations:
 * - Saves scroll positions to sessionStorage
 * - Restores scroll on back/forward navigation
 * - Scrolls to top on new navigation
 * - Supports hash link scrolling
 *
 * Should be rendered once in your app, typically in the root layout.
 *
 * @example
 * ```tsx
 * // In your root layout
 * export default function RootLayout({ children }) {
 *   return (
 *     <html>
 *       <body>
 *         <ScrollRestoration />
 *         {children}
 *       </body>
 *     </html>
 *   );
 * }
 * ```
 */
export function ScrollRestoration({ getKey }: ScrollRestorationProps) {
  useEffect(() => {
    const cleanup = initScrollRestoration({ getKey });
    return cleanup;
  }, [getKey]);

  // This component doesn't render anything
  return null;
}

/**
 * Hook to initialize scroll restoration
 *
 * Alternative to the ScrollRestoration component for more control.
 *
 * @example
 * ```tsx
 * function App() {
 *   useScrollRestoration();
 *   return <div>...</div>;
 * }
 * ```
 */
export function useScrollRestoration(options?: {
  getKey?: ScrollRestorationProps["getKey"];
}): void {
  useEffect(() => {
    const cleanup = initScrollRestoration({ getKey: options?.getKey });
    return cleanup;
  }, [options?.getKey]);
}
