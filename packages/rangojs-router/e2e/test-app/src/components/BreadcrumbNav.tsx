"use client";

import { Link, useHandle, Breadcrumbs } from "@rangojs/router/client";
import { Fragment, Suspense } from "react";
import { AsyncContent } from "./AsyncContent.js";
import { isThenable } from "./thenable.js";

/**
 * BreadcrumbNav - displays breadcrumb navigation from accumulated handle data.
 * Uses useHandle to reactively access breadcrumb items pushed by route handlers.
 */
export function BreadcrumbNav({ testId }: { testId?: string }) {
  const breadcrumbs = useHandle(Breadcrumbs);

  // Skip deferred (thenable) entries; deferred-aware rendering is in page-level components.
  const renderable = breadcrumbs.filter((crumb) => !isThenable(crumb));

  if (!renderable.length) return null;

  return (
    <nav
      aria-label="Breadcrumb"
      data-testid={testId}
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
        {renderable.map((crumb, index) => (
          <Fragment key={crumb.href}>
            <li
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
              {index === renderable.length - 1 ? (
                <span
                  data-testid={testId ? `${testId}-current` : undefined}
                  style={{ color: "#666" }}
                >
                  {crumb.label}
                </span>
              ) : (
                <Link
                  to={crumb.href}
                  data-testid={
                    testId
                      ? `${testId}-link-${crumb.label.toLowerCase()}`
                      : undefined
                  }
                  style={{ color: "#0066cc", textDecoration: "none" }}
                >
                  {crumb.label}
                </Link>
              )}
            </li>
            {crumb.content ? (
              <li data-testid={testId ? `${testId}-content` : undefined}>
                <Suspense fallback={<BreadcrumbSkeleton testId={testId} />}>
                  <AsyncContent content={crumb.content} />
                </Suspense>
              </li>
            ) : null}
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}

function BreadcrumbSkeleton({ testId }: { testId?: string }) {
  return (
    <span
      data-testid={testId ? `${testId}-skeleton` : undefined}
      style={{
        display: "inline-block",
        width: "60px",
        height: "1.2em",
        background:
          "linear-gradient(90deg, #e0e0e0 25%, #f0f0f0 50%, #e0e0e0 75%)",
        backgroundSize: "200% 100%",
        borderRadius: "4px",
      }}
    />
  );
}
