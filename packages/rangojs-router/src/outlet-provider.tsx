"use client";

import { useContext, useMemo, type ReactNode } from "react";
import { OutletContext, type OutletContextValue } from "./outlet-context.js";
import type { ResolvedSegment } from "./types.js";
import { AuditedOutlet } from "./suspense-audit-react.js";

interface OutletProviderProps {
  content: ReactNode;
  parallel?: ResolvedSegment[];
  segment?: ResolvedSegment;
  loaderData?: Record<string, any>;
  loaderStreams?: Record<string, unknown>;
  awaitedLoaderIds?: readonly string[];
  pending?: boolean;
  children: ReactNode;
}

function OutletContextProvider({
  content,
  parallel,
  segment,
  loaderData,
  loaderStreams,
  awaitedLoaderIds,
  pending = false,
  children,
}: OutletProviderProps): ReactNode {
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

// Dev only (suspense-audit.ts): the segment's mount, tracked under its
// provider.
function AuditedOutletProvider({
  children,
  ...props
}: OutletProviderProps): ReactNode {
  return (
    <OutletContextProvider {...props}>
      {props.segment ? (
        <AuditedOutlet segmentId={props.segment.id}>{children}</AuditedOutlet>
      ) : (
        children
      )}
    </OutletContextProvider>
  );
}

/**
 * Outlet content provider — stores parent context for useLoader chain walking.
 *
 * Chosen once per module, not by a branch inside the component: see
 * RouteContentWrapper (route-content-wrapper.tsx).
 */
export const OutletProvider: (props: OutletProviderProps) => ReactNode =
  process.env.NODE_ENV !== "production"
    ? AuditedOutletProvider
    : OutletContextProvider;
