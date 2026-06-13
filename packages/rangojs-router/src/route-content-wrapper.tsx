"use client";
import type { ReactNode } from "react";
import { Suspense, use } from "react";
import { invariant } from "./errors";
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
  content: Promise<ReactNode>;
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
  invariant(content instanceof Promise, "Suspender expects a Promise content");

  return use(content);
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
