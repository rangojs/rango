"use client";

import { useHandle } from "@rangojs/router/client";
import { CacheClearCrumbs } from "./cache-clear-crumbs.defs.js";

/** The layout's crumb as the browser's handle data holds it. */
export function CacheClearCrumbsBar() {
  const crumbs = useHandle(CacheClearCrumbs) ?? [];
  return (
    <ul data-testid="ccc-crumbs">
      {crumbs.map((crumb, index) => (
        <li key={index} data-testid="ccc-crumb">
          {crumb}
        </li>
      ))}
    </ul>
  );
}
