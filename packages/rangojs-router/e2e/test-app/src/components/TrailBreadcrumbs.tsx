"use client";

import { useHandle, Breadcrumbs } from "@rangojs/router/client";
import { Fragment, Suspense, use, type ReactNode } from "react";

/**
 * User-land breadcrumb component using the built-in Breadcrumbs handle.
 * Tests that useHandle(Breadcrumbs) works correctly with a custom renderer.
 */
export function TrailBreadcrumbs() {
  const breadcrumbs = useHandle(Breadcrumbs);

  if (!breadcrumbs.length) return null;

  return (
    <nav aria-label="Trail">
      <ol>
        {breadcrumbs.map((crumb, index) => (
          <Fragment key={crumb.href}>
            <li>
              {index > 0 && <span aria-hidden="true">›</span>}
              {index === breadcrumbs.length - 1 ? (
                <span aria-current="page">{crumb.label}</span>
              ) : (
                <a href={crumb.href}>{crumb.label}</a>
              )}
            </li>
            {crumb.content != null && (
              <li>
                <Suspense>
                  <AsyncContent content={crumb.content} />
                </Suspense>
              </li>
            )}
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}

function AsyncContent({
  content,
}: {
  content: ReactNode | Promise<ReactNode>;
}) {
  if (!(content instanceof Promise)) return <>{content}</>;
  return <>{use(content)}</>;
}
