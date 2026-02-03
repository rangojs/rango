"use client";

import { useHref, Link } from "@rangojs/router/client";

interface HrefTestClientProps {
  isDetailPage?: boolean;
}

/**
 * Client component for testing useHref hook
 *
 * With HrefContext.Provider wrapping the RSC render, useHref() now works
 * during SSR without hydration mismatch. No need for server-provided initial props.
 */
export function HrefTestClient({ isDetailPage }: HrefTestClientProps) {
  const href = useHref();

  // useHref works during SSR because HrefContext is provided by renderSegments
  const localIndex = href("index");
  const absoluteBlog = href("blog.index");
  const pathBased = href("/about");
  const localDetail = isDetailPage
    ? href("detail", { id: "client-item" })
    : href("detail", { id: "from-client" });

  return (
    <div data-testid="client-href-test">
      <h3>Resolved URLs (useHref)</h3>
      <ul>
        <li data-testid="client-local-index">
          Local index: <code>{localIndex}</code>
        </li>
        <li data-testid="client-local-detail">
          Local detail: <code>{localDetail}</code>
        </li>
        <li data-testid="client-absolute-blog">
          Absolute blog.index: <code>{absoluteBlog}</code>
        </li>
        <li data-testid="client-path-based">
          Path-based /about: <code>{pathBased}</code>
        </li>
      </ul>

      <h3>Client-rendered Links</h3>
      <div data-testid="client-links">
        <Link to={localIndex} data-testid="client-link-local-index">
          Local Index Link
        </Link>
        {" | "}
        <Link to={localDetail} data-testid="client-link-local-detail">
          Local Detail Link
        </Link>
        {" | "}
        <Link to={absoluteBlog} data-testid="client-link-absolute-blog">
          Blog Link
        </Link>
      </div>
    </div>
  );
}
