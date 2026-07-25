"use client";
import type { ReactNode } from "react";
import { Suspense, use, useMemo } from "react";
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
 *
 * SPIKE (streaming useLoader): a PENDING aggregate no longer resolves here
 * above the children. It is split into stable per-loader promises
 * (aggregate.then(results => results[index])) provided via loaderStreams, and
 * children render immediately — useLoader suspends at the read site, with the
 * LoaderBoundary's loading() fallback as the catching boundary. Consequences
 * to catalog: loading() shows only while a reader is actually suspended, and
 * boundary-level errorFallback handling moves to read-site throws
 * (decodeLoaderEntry). Resolved arrays (forceAwait/action lanes) keep the
 * synchronous decode so those lanes still commit whole.
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
  const pending = loaderDataPromise instanceof Promise;
  const loaderStreams = useMemo(() => {
    if (!pending) return undefined;
    const aggregate = loaderDataPromise as Promise<any[]>;
    const streams: Record<string, unknown> = {};
    loaderIds.forEach((id, index) => {
      streams[id] = aggregate.then((results) => results[index]);
    });
    return streams;
  }, [pending, loaderDataPromise, loaderIds]);

  if (pending) {
    return (
      <OutletProvider
        key={outletKey}
        content={outletContent}
        segment={segment}
        parallel={parallel}
        loaderStreams={loaderStreams}
      >
        {children}
      </OutletProvider>
    );
  }

  const { loaderData, errorFallback } = decodeLoaderResults(
    loaderDataPromise,
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
