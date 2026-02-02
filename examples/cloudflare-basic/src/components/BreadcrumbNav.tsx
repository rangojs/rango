"use client";

import { Link, useHandle } from "@rangojs/router/client";
import { Breadcrumbs } from "../handles/breadcrumbs.js";

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
              <span style={{ color: "#666" }} data-testid={`breadcrumb-${crumb.label.toLowerCase()}`}>
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
          </li>
        ))}
      </ol>
    </nav>
  );
}
