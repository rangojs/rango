"use client";
import type { ReactNode } from "react";
import { Suspense, use, useId } from "react";

/**
 * Stable async wrapper component for route content
 * Using a module-level component ensures React sees the same component reference
 * across renders, preventing unnecessary remounts during actions.
 *
 * When content is a pending promise, React suspends and shows the nearest
 * Suspense fallback. When content is already resolved, it renders immediately
 * without suspension.
 */
export function RouteContentWrapper({
  content,
  fallback,
}: {
  content: Promise<ReactNode> | ReactNode;
  fallback?: ReactNode;
}): ReactNode {
  const id = useId();
  if (!content) {
    // Already resolved
    return content as ReactNode;
  }
  return (
    <Suspense fallback={fallback ?? null} key={"route-content-suspense-" + id}>
      <Suspender content={content} key={id} />
    </Suspense>
  );
}

const Suspender = ({
  content,
}: {
  content: Promise<ReactNode> | ReactNode;
}): ReactNode => {
  return use(content instanceof Promise ? content : Promise.resolve(content));
};
