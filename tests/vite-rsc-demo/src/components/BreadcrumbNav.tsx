"use client";

import { Link, useHandle } from "@rangojs/router/client";
import { Breadcrumbs } from "../handles/breadcrumbs.js";
import { Fragment, ReactNode, Suspense, use } from "react";

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
          <Fragment key={crumb.href}>
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
                <span style={{ color: "#666" }}>{crumb.label}</span>
              ) : (
                <Link
                  to={crumb.href}
                  style={{ color: "#0066cc", textDecoration: "none" }}
                >
                  {crumb.label}
                </Link>
              )}
            </li>
            {crumb.content ? (
              <Fragment key={crumb.href + `-promise-component-${crumb.href}`}>
                <Suspense
                  key="promise-component-suspense"
                  fallback={<BreadcrumbSkeleton />}
                >
                  <PromiseComponent content={crumb.content} />
                </Suspense>
              </Fragment>
            ) : null}
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}

function BreadcrumbSkeleton() {
  return (
    <span
      style={{
        display: "inline-block",
        width: "60px",
        height: "1.6em",
        backgroundColor: "#e0e0e0",
        borderRadius: "4px",
        animation: "pulse 1.5s ease-in-out infinite",
      }}
    />
  );
}

const PromiseComponent = ({
  content,
}: {
  content: Promise<ReactNode> | ReactNode;
}) => {
  if (!(content instanceof Promise)) {
    return <>{content}</>;
  }
  const component = use(content);
  return component;
};
