"use client";

import {
  useContext,
  useMemo,
  type ComponentProps,
  type ReactNode,
} from "react";
import { OutletContext, type OutletContextValue } from "./outlet-context.js";
import type { ResolvedSegment } from "./types.js";
import { AuditedOutlet } from "./suspense-audit-react.js";

/**
 * Outlet content provider — stores parent context for useLoader chain walking.
 */
export function OutletProvider({
  content,
  parallel,
  segment,
  loaderData,
  loaderStreams,
  awaitedLoaderIds,
  pending = false,
  children,
}: {
  content: ReactNode;
  parallel?: ResolvedSegment[];
  segment?: ResolvedSegment;
  loaderData?: Record<string, any>;
  loaderStreams?: Record<string, unknown>;
  awaitedLoaderIds?: readonly string[];
  pending?: boolean;
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
      loaderStreams,
      awaitedLoaderIds,
      pending,
      parent: parentContext,
      loading: segment?.loading,
    }),
    [
      content,
      parallel,
      segment,
      loaderData,
      loaderStreams,
      awaitedLoaderIds,
      pending,
      parentContext,
    ],
  );

  return (
    <OutletContext.Provider value={value}>{children}</OutletContext.Provider>
  );
}

// Dev only (suspense-audit.ts): OutletProvider with the segment's mount
// tracked under it. Chosen where the element is created, inside a NODE_ENV
// test: see AuditedRouteContent (route-content-wrapper.tsx).
export function AuditedOutletProvider({
  children,
  ...props
}: ComponentProps<typeof OutletProvider>): ReactNode {
  return (
    <OutletProvider {...props}>
      {props.segment ? (
        <AuditedOutlet segmentId={props.segment.id}>{children}</AuditedOutlet>
      ) : (
        children
      )}
    </OutletProvider>
  );
}
