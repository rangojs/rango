"use client";

import { useHandle, Breadcrumbs } from "@rangojs/router/client";
import { Fragment, Suspense } from "react";
import { AsyncContent } from "./AsyncContent.js";

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

/**
 * Resolve-by-default renderer used by the deferred-handle-nav e2e. A deferred
 * breadcrumb (a pushed Promise or `ctx.use(Breadcrumbs).defer()`) reaches the
 * consumer RESOLVED — never a Promise. On a soft navigation the store HOLDS the
 * previous breadcrumbs (the whole handle, since it has a deferred entry) until
 * every deferred value resolves, then swaps in the resolved set; there is no
 * per-crumb pending marker. This component exposes the crumb labels + count so
 * the e2e can observe the held-previous-then-resolved transition.
 */
export function ResolvedTrailBreadcrumbs() {
  const breadcrumbs = useHandle(Breadcrumbs);

  return (
    <nav aria-label="ResolvedTrail" data-testid="resolved-trail-nav">
      <span data-testid="resolved-crumb-count">{breadcrumbs.length}</span>
      <ol>
        {breadcrumbs.map((crumb, index) => (
          <li key={index} data-testid={`resolved-crumb-${index}`}>
            <span data-testid="resolved-crumb-label">{crumb.label}</span>
            {crumb.content != null && (
              <Suspense>
                <AsyncContent content={crumb.content} />
              </Suspense>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
