'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * Context for outlet content
 */
interface OutletContextValue {
  content: ReactNode;
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
 * Provider for outlet content - used internally by renderSegments
 */
export function OutletProvider({
  content,
  children,
}: {
  content: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <OutletContext.Provider value={{ content }}>
      {children}
    </OutletContext.Provider>
  );
}

/**
 * Hook to access outlet content (future API)
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
