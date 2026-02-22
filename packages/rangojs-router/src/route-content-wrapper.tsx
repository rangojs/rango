"use client";
import type { ReactNode } from "react";
import { Suspense, use, useId } from "react";
import { invariant } from "./errors";
import { OutletProvider } from "./outlet-provider.js";
import type { ResolvedSegment } from "./types.js";
import { isLoaderDataResult } from "./types.js";

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
  if (!content) {
    // Already resolved
    return content as ReactNode;
  }
  return (
    <Suspense fallback={fallback ?? null} key={segmentId ? "route-content-suspense-" + segmentId : undefined}>
      <Suspender content={content} key={segmentId} />
    </Suspense>
  );
}

export function RouteContentWrapperCallback<T>({
  resolve,
  fallback,
  children,
}: {
  resolve: Promise<T> | T;
  fallback?: ReactNode;
  children: (data: T) => ReactNode;
}): ReactNode {
  const id = useId();
  invariant(children, "RouteContentWrapperCallback requires children");
  invariant(
    typeof children === "function",
    "RouteContentWrapperCallback requires children to be a function"
  );
  invariant(
    resolve !== undefined,
    "RouteContentWrapperCallback requires resolve"
  );
  return (
    <Suspense
      fallback={fallback ?? null}
      key={"route-content-suspense-callback-" + id}
    >
      <SuspenderCallback resolve={resolve} key={id}>
        {children}
      </SuspenderCallback>
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

const SuspenderCallback = <T,>({
  resolve,
  children,
}: {
  resolve: Promise<T> | T;
  children: (data: T) => ReactNode;
}): ReactNode => {
  return resolve instanceof Promise
    ? children(use(resolve))
    : children(resolve);
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

  // Build loaderData record from resolved values
  const loaderData: Record<string, any> = {};
  let loaderErrorFallback: ReactNode = null;

  loaderIds.forEach((id, i) => {
    const result = resolvedData[i];

    if (isLoaderDataResult(result)) {
      if (result.ok) {
        loaderData[id] = result.data;
      } else {
        if (result.fallback) {
          loaderErrorFallback = result.fallback;
        } else {
          throw new Error(result.error.message);
        }
      }
    } else {
      // Legacy format - direct data
      loaderData[id] = result;
    }
  });

  return (
    <OutletProvider
      key={outletKey}
      content={outletContent}
      segment={segment}
      parallel={parallel}
      loaderData={Object.keys(loaderData).length > 0 ? loaderData : undefined}
    >
      {loaderErrorFallback ?? children}
    </OutletProvider>
  );
}
