"use client";

import { Breadcrumbs, useHandle, useSegments } from "@rangojs/router/client";
import { Fragment, Suspense, use, type ReactNode } from "react";

function CrumbContent({
  content,
}: {
  content: ReactNode | Promise<ReactNode>;
}) {
  return <>{content instanceof Promise ? use(content) : content}</>;
}

// The fixture's own crumbs only: the app's root layout pushes its own. A
// crumb's content boundary is keyed by its href, so a crumb whose href stays
// the same across pages keeps its <Suspense> mounted. useSegments() reads
// the full state, which a handle notification also moves.
export function HcTrail() {
  const crumbs = useHandle(Breadcrumbs).filter((crumb) =>
    crumb.href.startsWith("/handles-commit"),
  );
  const { location } = useSegments();
  return (
    <ol data-testid="hc-trail">
      <li data-testid="hc-segments">{location.pathname}</li>
      {crumbs.map((crumb) => (
        <Fragment key={crumb.href}>
          <li data-testid="hc-crumb">{crumb.label}</li>
          {crumb.content ? (
            <Suspense
              fallback={<span data-testid="hc-crumb-fallback">loading</span>}
            >
              <CrumbContent content={crumb.content} />
            </Suspense>
          ) : null}
        </Fragment>
      ))}
    </ol>
  );
}
