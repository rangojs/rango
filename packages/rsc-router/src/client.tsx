"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ResolvedSegment } from "./types";

/**
 * Context for outlet content
 */
interface OutletContextValue {
  content: ReactNode;
  parallel?: ResolvedSegment[];
  segment?: ResolvedSegment;
}

const OutletContext = createContext<OutletContextValue | null>(null);

/**
 * Outlet component - renders child content in layouts
 *
 * @example
 * ```tsx
 * function BlogLayout() {
 *   return (
 *     <div>
 *       <h1>Blog</h1>
 *       <Outlet />
 *     </div>
 *   );
 * }
 * ```
 */
export function Outlet(): ReactNode {
  const context = useContext(OutletContext);
  return context?.content ?? null;
}
/**
 * ParallelOutlet component - renders content for a named parallel slot
 *
 * @param name - The slot name (must start with @, e.g., "@modal", "@sidebar")
 *
 * @example
 * ```tsx
 * function DashboardLayout() {
 *   return (
 *     <div>
 *       <h1>Dashboard</h1>
 *       <ParallelOutlet name="@sidebar" />
 *       <ParallelOutlet name="@modal" />
 *     </div>
 *   );
 * }
 * ```
 */
export function ParallelOutlet({ name }: { name: `@${string}` }): ReactNode {
  const context = useContext(OutletContext);
  return useMemo(() => {
    if (!context?.parallel) return null;
    const segment = context.parallel.find((seg) => seg.slot === name);
    return segment?.component ?? null;
  }, [context, name]);
}

/**
 * Provider for outlet content - used internally by renderSegments
 */
export function OutletProvider({
  content,
  parallel,
  segment,
  children,
}: {
  content: ReactNode;
  parallel?: ResolvedSegment[];
  segment?: ResolvedSegment;
  children: ReactNode;
}): ReactNode {
  return (
    <OutletContext.Provider value={{ content, parallel, segment }}>
      {children}
    </OutletContext.Provider>
  );
}

/**
 * Hook to access outlet content programmatically
 *
 * Alternative to using <Outlet /> component. Useful when you need
 * direct access to the outlet content in your logic.
 *
 * @example
 * ```tsx
 * function BlogLayout() {
 *   const outlet = useOutlet();
 *   return <div><h1>Blog</h1>{outlet}</div>;
 * }
 * ```
 */
export function useOutlet(): ReactNode {
  const context = useContext(OutletContext);
  return context?.content ?? null;
}
