"use client";

import { Link, useHandle } from "@rangojs/router/client";
import { Breadcrumbs } from "../handles.js";

// Reads breadcrumb items accumulated by route handlers via ctx.use(Breadcrumbs).
export function BreadcrumbNav() {
  const breadcrumbs = useHandle(Breadcrumbs);

  if (!breadcrumbs.length) return null;

  return (
    <nav aria-label="Breadcrumb" data-testid="breadcrumbs">
      <ol
        style={{
          display: "flex",
          gap: "0.5rem",
          listStyle: "none",
          padding: 0,
        }}
      >
        {breadcrumbs.map((crumb, index) => (
          <li key={crumb.href} style={{ display: "flex", gap: "0.5rem" }}>
            {index > 0 && <span aria-hidden="true">/</span>}
            {index === breadcrumbs.length - 1 ? (
              <span data-testid={`breadcrumb-${crumb.label.toLowerCase()}`}>
                {crumb.label}
              </span>
            ) : (
              <Link
                to={crumb.href}
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
