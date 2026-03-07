"use client";

import { href, Link, useHref } from "@rangojs/router/client";

interface HrefTestClientProps {
  isDetailPage?: boolean;
}

/**
 * Client component for testing useHref() (mount-aware) and href() (absolute)
 *
 * useHref() auto-prefixes with the include() mount path.
 * href() is used for absolute paths outside the current mount.
 */
export function HrefTestClient({ isDetailPage }: HrefTestClientProps) {
  const localHref = useHref();

  // useHref() auto-prefixes with mount from include("/href", ...)
  const localIndex = localHref("/");
  const absoluteBlog = href("/blog");
  const localDetail = isDetailPage
    ? localHref(`/client-item`)
    : localHref(`/from-client`);

  // Trailing-slash mount normalization: href() must strip trailing slash
  // from mount before joining to avoid double-slash paths (I1 regression).
  const trailingSlashRoot = href("/" as any, "/articles/");
  const trailingSlashChild = href("/blog" as any, "/articles/");

  return (
    <div data-testid="client-href-test">
      <h3>Resolved URLs (href + useMount)</h3>
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
        <li data-testid="client-trailing-slash-root">
          Trailing slash root: <code>{trailingSlashRoot}</code>
        </li>
        <li data-testid="client-trailing-slash-child">
          Trailing slash child: <code>{trailingSlashChild}</code>
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
