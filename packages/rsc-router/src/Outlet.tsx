'use client';

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

const OutletContext = createContext<ReactNode | null>(null);

/**
 * Outlet component - renders nested route content
 * Similar to React Router's Outlet but for RSC
 */
export function Outlet() {
  const content = useContext(OutletContext);
  return <>{content}</>;
}

/**
 * Provider that supplies content to Outlet components
 * Used internally by the router to inject nested content
 */
export function OutletProvider({
  children,
  content
}: {
  children: ReactNode;
  content: ReactNode;
}) {
  return (
    <OutletContext.Provider value={content}>
      {children}
    </OutletContext.Provider>
  );
}

/**
 * Hook to access the current outlet content
 * Useful for layouts that need to conditionally render based on child content
 */
export function useOutlet(): ReactNode | null {
  return useContext(OutletContext);
}