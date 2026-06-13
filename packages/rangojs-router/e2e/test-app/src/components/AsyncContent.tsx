"use client";

import { use, type ReactNode } from "react";

/**
 * Renders breadcrumb `content` that may be sync or a Promise. Shared by the
 * breadcrumb renderers; wrap in <Suspense> when the content can be a Promise.
 */
export function AsyncContent({
  content,
}: {
  content: ReactNode | Promise<ReactNode>;
}) {
  if (!(content instanceof Promise)) return <>{content}</>;
  return <>{use(content)}</>;
}
