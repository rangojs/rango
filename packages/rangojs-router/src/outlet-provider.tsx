"use client";

import { useContext, useMemo, type ReactNode } from "react";
import { OutletContext, type OutletContextValue } from "./outlet-context.js";
import type { ResolvedSegment } from "./types.js";

/**
 * Outlet content provider — stores parent context for useLoader chain walking.
 */
export function OutletProvider({
  content,
  parallel,
  segment,
  loaderData,
  children,
}: {
  content: ReactNode;
  parallel?: ResolvedSegment[];
  segment?: ResolvedSegment;
  loaderData?: Record<string, any>;
  children: ReactNode;
}): ReactNode {
  // Get parent context to enable walking up the chain for loader lookups
  const parentContext = useContext(OutletContext);

  const value = useMemo(
    () => ({
      content,
      parallel,
      segment,
      loaderData,
      parent: parentContext,
      loading: segment?.loading,
    }),
    [content, parallel, segment, loaderData, parentContext],
  );

  return (
    <OutletContext.Provider value={value}>{children}</OutletContext.Provider>
  );
}
