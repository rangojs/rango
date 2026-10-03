"use client";

import { useEffect, useState } from "react";
import { Link, useLocationState } from "@rangojs/router/client";
import {
  CarriedItems,
  GridState,
  ListSort,
  ServerPageStamp,
} from "../location-states.js";

/**
 * #994 "load more". `items` is the page the server rendered for this URL; the
 * pages already on screen arrive as CarriedItems (clearOnReload) on the Link.
 * After a client navigation both are shown; after a document load only
 * `items`, as the server rendered them. ServerPageStamp is the state the
 * route's handler sets on every request.
 *
 * `items` is filtered against the carried ones to work around a router
 * ordering defect: a navigation applies the destination entry's state to a
 * mounted reader (navigation-transaction.ts dispatches `__rsc_locationstate`
 * in commit) before the destination's tree commits (partial-update.ts), and
 * until it does the carried items include the page still on screen.
 */
export function LoadMoreList({
  basePath,
  page,
  items,
}: {
  basePath: string;
  page: number;
  items: string[];
}) {
  const carried = useLocationState(CarriedItems) ?? [];
  const sort = useLocationState(ListSort);
  const serverStamp = useLocationState(ServerPageStamp);
  const shown = [
    ...carried,
    ...items.filter((item) => !carried.includes(item)),
  ];
  return (
    <section>
      <p>
        page <span data-testid="lm-page">{page}</span>, carried{" "}
        <span data-testid="lm-carried-count">{carried.length}</span>, sort{" "}
        <span data-testid="lm-sort">{sort?.order ?? "none"}</span>, server stamp{" "}
        <span data-testid="lm-server-page">{serverStamp?.page ?? "none"}</span>
      </p>
      <ul data-testid="lm-items">
        {shown.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <Link
        to={`${basePath}?page=${page + 1}`}
        state={[CarriedItems(shown), ListSort({ order: "asc" })]}
        scroll={false}
        data-testid="lm-more"
      >
        Load more
      </Link>
    </section>
  );
}

/**
 * #994 location state another app version stored. Each reader shows its value
 * or "none": a typed slot (`grid-value`) and plain state (`plain-value`).
 * `step` is the server-rendered `?step`, so the e2e can tell which entry is
 * committed.
 *
 * Nothing in location state survives a version change, so no slot can signal
 * that the client snapshots are applied: `grid-mounted` turns "yes" in an
 * effect, which runs after them.
 */
export function AppVersionPanel({
  basePath,
  step,
}: {
  basePath: string;
  step: string;
}) {
  const grid = useLocationState(GridState);
  const plain = useLocationState<{ from?: string }>();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <section>
      <p>
        step <span data-testid="grid-step">{step}</span>, mounted{" "}
        <span data-testid="grid-mounted">{mounted ? "yes" : "no"}</span>
      </p>
      <p>
        typed{" "}
        <span data-testid="grid-value">
          {grid ? `${grid.order}:${grid.page}` : "none"}
        </span>
        , plain <span data-testid="plain-value">{plain?.from ?? "none"}</span>
      </p>
      <Link
        to={`${basePath}?step=typed`}
        state={[GridState({ order: "desc", page: 3 })]}
        data-testid="grid-write"
      >
        Write typed state
      </Link>{" "}
      <Link
        to={`${basePath}?step=plain`}
        state={{ from: "panel" }}
        data-testid="plain-write"
      >
        Write plain state
      </Link>{" "}
      <Link to={`${basePath}?step=next`} data-testid="grid-next">
        Next entry, no state
      </Link>
    </section>
  );
}
