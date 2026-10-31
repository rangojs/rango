"use client";

import { Breadcrumbs, useHandle } from "@rangojs/router/client";

// The fixture's own crumbs only: the app's root layout pushes its own.
export function ShoTrail() {
  const crumbs = useHandle(Breadcrumbs).filter((crumb) =>
    crumb.href.startsWith("/streamed-handle-owner"),
  );
  return (
    <ol>
      {crumbs.map((crumb) => (
        <li key={crumb.href} data-testid="sho-crumb">
          {crumb.label}
        </li>
      ))}
    </ol>
  );
}
