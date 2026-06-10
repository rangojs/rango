"use client";

import { Suspense, use, type ReactNode } from "react";
import { Link, useHandle } from "@rangojs/router/client";
import { Breadcrumbs } from "../handles/breadcrumbs.js";

/**
 * Render a crumb's optional content, awaiting it when it is a Promise. The
 * cached-handles regression relies on this: a Promise<ReactNode> content must
 * still resolve after a cache HIT (it would be {} if the cache flattened it).
 */
function CrumbContent({
  content,
}: {
  content: ReactNode | Promise<ReactNode>;
}) {
  if (!(content instanceof Promise)) return <>{content}</>;
  return <>{use(content)}</>;
}

/**
 * BreadcrumbNav - displays breadcrumb navigation from accumulated handle data.
 * Uses useHandle to reactively access breadcrumb items pushed by route handlers.
 */
export function BreadcrumbNav() {
  const breadcrumbs = useHandle(Breadcrumbs);

  if (!breadcrumbs.length) return null;

  return (
    <nav
      aria-label="Breadcrumb"
      data-testid="breadcrumbs"
      style={{
        padding: "0.5rem 0",
        marginBottom: "1rem",
        fontSize: "0.875rem",
      }}
    >
      <ol
        style={{
          display: "flex",
          gap: "0.5rem",
          listStyle: "none",
          margin: 0,
          padding: 0,
        }}
      >
        {breadcrumbs.map((crumb, index) => (
          <li
            key={crumb.href}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
            }}
          >
            {index > 0 && (
              <span style={{ color: "#999" }} aria-hidden="true">
                /
              </span>
            )}
            {index === breadcrumbs.length - 1 ? (
              <span
                style={{ color: "#666" }}
                data-testid={`breadcrumb-${crumb.label.toLowerCase()}`}
              >
                {crumb.label}
              </span>
            ) : (
              <Link
                to={crumb.href}
                style={{ color: "#0066cc", textDecoration: "none" }}
                data-testid={`breadcrumb-link-${crumb.label.toLowerCase()}`}
              >
                {crumb.label}
              </Link>
            )}
            {crumb.content != null && (
              <Suspense>
                <CrumbContent content={crumb.content} />
              </Suspense>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
