"use client";

import {
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { OutletContext, type OutletContextValue } from "./outlet-context.js";
import type { ResolvedSegment } from "./types.js";

/**
 * Provider for outlet content - used internally by renderSegments
 *
 * Stores a reference to parent context so useLoader can walk up the chain
 * to find loader data from parent layouts. If this segment defines a loading
 * component, Outlet will wrap content with Suspense using that as fallback.
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
    [content, parallel, segment, loaderData, parentContext]
  );

  return (
    <OutletContext.Provider value={value}>{children}</OutletContext.Provider>
  );
}
