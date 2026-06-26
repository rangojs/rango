"use client";

import { useHandle, Breadcrumbs } from "@rangojs/router/client";

/**
 * Resolve-by-default renderer for the cloudflare-basic deferred-handle-nav e2e.
 * A deferred breadcrumb (a pushed Promise or `ctx.use(Breadcrumbs).defer()`)
 * reaches the consumer RESOLVED — never a Promise. On a soft navigation the
 * store HOLDS the previous breadcrumbs (the whole handle, since it has a deferred
 * entry) until every deferred value resolves, then swaps in the resolved set;
 * there is no per-crumb pending marker. The built-in Breadcrumbs handle is used
 * here because only the built-in supports ctx.use(Breadcrumbs).defer().
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
          </li>
        ))}
      </ol>
    </nav>
  );
}
