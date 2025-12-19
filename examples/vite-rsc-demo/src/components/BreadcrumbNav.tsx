"use client";

import { useHandle } from "rsc-router/client";
import { breadcrumbs, type Breadcrumb } from "../handles/breadcrumbs.js";

export function BreadcrumbNav() {
  const crumbs = useHandle(breadcrumbs);
  console.log("crumbs", crumbs);

  return (
    <nav
      style={{
        padding: "0.5rem 1rem",
        marginBottom: "1rem",
        background: "#f8f8f8",
        borderRadius: "4px",
        fontSize: "0.9rem",
      }}
    >
      Breadcrumbs:
      {crumbs.map((crumb: Breadcrumb, index: number) => (
        <span key={crumb.href}>
          {index > 0 && (
            <span style={{ margin: "0 0.5rem", color: "#999" }}>/</span>
          )}
          {index === crumbs.length - 1 ? (
            <span style={{ color: "#666" }}>{crumb.label}</span>
          ) : (
            <a
              href={crumb.href}
              style={{ color: "#0066cc", textDecoration: "none" }}
            >
              {crumb.label}
            </a>
          )}
        </span>
      ))}
    </nav>
  );
}
