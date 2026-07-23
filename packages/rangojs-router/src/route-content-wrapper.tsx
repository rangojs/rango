"use client";
import type { ReactNode } from "react";
import { Suspense, use } from "react";
import { OutletProvider } from "./outlet-provider.js";
import type { ResolvedSegment } from "./types.js";
import { decodeLoaderResults } from "./decode-loader-results.js";

/**
 * Stable async wrapper component for route content
 * Using a module-level component ensures React sees the same component reference
 * across renders, preventing unnecessary remounts during actions.
 *
 * When content is a pending promise, React suspends and shows the nearest
 * Suspense fallback. When content is already resolved, it renders immediately
 * without suspension.
 *
 * @param segmentId - Stable ID from segment, used for consistent keys across renders
 */
export function RouteContentWrapper({
  content,
  fallback,
  segmentId,
}: {
  // Normally a pending promise (use() suspends -> fallback). forceAwait paths
  // pass an already-resolved node so Suspender renders it without suspending.
  content: Promise<ReactNode> | ReactNode;
  fallback?: ReactNode;
  segmentId?: string;
}): ReactNode {
  return (
    <Suspense
      fallback={fallback ?? null}
      key={segmentId ? "route-content-suspense-" + segmentId : undefined}
    >
      <Suspender content={content} key={segmentId} />
    </Suspense>
  );
}

const Suspender = ({
  content,
}: {
  content: Promise<ReactNode> | ReactNode;
}): ReactNode => {
  // Normally content is a pending promise -> use() suspends and the wrapping
  // Suspense shows the loading() fallback. forceAwait paths (popstate,
  // stale-revalidation, fully-prefetched nav) instead pass the ALREADY-RESOLVED
  // node so first render does not suspend for a microtask and flash the loading()
  // fallback on a NORMAL (non-transition) commit. The wrapper tree
  // (RouteContentWrapper > Suspense > Suspender) is identical either way, so this
  // preserves tree structure (see docs/tree-structure.md) — only whether use()
  // suspends differs, exactly like LoaderResolver's resolved-data branch.
  return content instanceof Promise ? use(content) : content;
};

/**
 * LoaderBoundary - Client component that resolves loader promises and renders OutletProvider
 *
 * This component enables streaming with loaders by:
 * 1. Receiving loader promises (serializable across RSC boundary)
 * 2. Using React's use() to resolve them (triggers Suspense)
 * 3. Rendering OutletProvider with resolved data
 *
 * The callback logic lives inside this client component, avoiding the
 * "Functions are not valid as a child of Client Components" error.
 */
export interface LoaderBoundaryProps {
  loaderDataPromise: Promise<any[]> | any[];
  loaderIds: string[];
  fallback?: ReactNode;
  outletKey: string;
  outletContent: ReactNode;
  segment: ResolvedSegment;
  parallel?: ResolvedSegment[];
  children: ReactNode;
}

export function LoaderBoundary({
  loaderDataPromise,
  loaderIds,
  fallback,
  outletKey,
  outletContent,
  segment,
  parallel,
  children,
}: LoaderBoundaryProps): ReactNode {
  return (
    <Suspense fallback={fallback ?? null} key={`loader-boundary-${outletKey}`}>
      <LoaderResolver
        loaderDataPromise={loaderDataPromise}
        loaderIds={loaderIds}
        outletKey={outletKey}
        outletContent={outletContent}
        segment={segment}
        parallel={parallel}
      >
        {children}
      </LoaderResolver>
    </Suspense>
  );
}

/**
 * Internal component that resolves loader promises and renders OutletProvider
 */
function LoaderResolver({
  loaderDataPromise,
  loaderIds,
  outletKey,
  outletContent,
  segment,
  parallel,
  children,
}: Omit<LoaderBoundaryProps, "fallback">): ReactNode {
  // Resolve loader promises using React's use()
  const resolvedData =
    loaderDataPromise instanceof Promise
      ? use(loaderDataPromise)
      : loaderDataPromise;

  const { loaderData, errorFallback } = decodeLoaderResults(
    resolvedData,
    loaderIds,
  );

  return (
    <OutletProvider
      key={outletKey}
      content={outletContent}
      segment={segment}
      parallel={parallel}
      loaderData={Object.keys(loaderData).length > 0 ? loaderData : undefined}
    >
      {errorFallback ?? children}
    </OutletProvider>
  );
}
