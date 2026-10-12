"use client";

import { Breadcrumbs, useHandle, useLoader } from "@rangojs/router/client";
import { HistoryHandlesTickLoader } from "./history-handles.defs.js";

// The crumbs this fixture pushes, without the app's own (the root's Home).
export function HistoryHandlesCrumbs() {
  const crumbs = useHandle(Breadcrumbs).filter((crumb) =>
    crumb.href.startsWith("/history-handles"),
  );
  return (
    <ol data-testid="hch-crumbs">
      {crumbs.map((crumb) => (
        <li key={crumb.href} data-testid="hch-crumb">
          {crumb.label}
        </li>
      ))}
    </ol>
  );
}

export function HistoryHandlesTick() {
  const { data } = useLoader(HistoryHandlesTickLoader);
  return <p data-testid="hch-b-runs">{data.runs}</p>;
}
