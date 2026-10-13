"use client";

import { Breadcrumbs, useHandle, useLoader } from "@rangojs/router/client";
import { HaaAwaitLoader } from "./handles-after-await.defs.js";

// The fixture's own crumbs only: the app's root layout pushes its own.
export function HaaTrail() {
  const crumbs = useHandle(Breadcrumbs).filter((crumb) =>
    crumb.href.startsWith("/handles-after-await"),
  );
  return (
    <ol data-testid="haa-trail">
      {crumbs.map((crumb) => (
        <li key={crumb.href} data-testid="haa-crumb">
          {crumb.label}
        </li>
      ))}
    </ol>
  );
}

export function HaaLoaderView() {
  const { data } = useLoader(HaaAwaitLoader);
  return (
    <p data-testid="haa-loader-value">{`loader ${data.v} run ${data.run}`}</p>
  );
}
