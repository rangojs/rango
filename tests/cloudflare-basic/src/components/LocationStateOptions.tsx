"use client";

import { Link, useLocationState } from "@rangojs/router/client";
import {
  CarriedItems,
  ListSort,
  ServerPageStamp,
  ValidatedGrid,
  VersionedGrid,
} from "../location-states.js";

/**
 * #994 "load more". `items` is the page the server rendered for this URL; the
 * pages already on screen arrive as CarriedItems (clearOnReload) on the Link.
 * After a client navigation both are shown; after a document load only
 * `items`, as the server rendered them. ServerPageStamp is the state the
 * route's handler sets on every request.
 *
 * `items` is filtered against the carried ones: a navigation applies the new
 * entry's state to a mounted reader (navigation-transaction.ts dispatches
 * `__rsc_locationstate` in commit) before the new page's props commit, so for
 * one render the carried items already include the page still on screen.
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
    <section data-testid="lm-list">
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
 * #994 version / validate. Each reader shows `order:page` or "none"; the slot
 * keys are rendered so the e2e can rewrite a slot as another deploy stored it.
 */
export function GridOptionsPanel({ basePath }: { basePath: string }) {
  const versioned = useLocationState(VersionedGrid);
  const validated = useLocationState(ValidatedGrid);
  const control = useLocationState(ListSort);
  const grid = { order: "desc", page: 3 } as const;
  return (
    <section data-testid="grid-options">
      <p>
        versioned{" "}
        <span data-testid="vg-value">
          {versioned ? `${versioned.order}:${versioned.page}` : "none"}
        </span>{" "}
        <code data-testid="vg-key">{VersionedGrid.__rsc_ls_key}</code>
      </p>
      <p>
        validated{" "}
        <span data-testid="val-value">
          {validated ? `${validated.order}:${validated.page}` : "none"}
        </span>{" "}
        <code data-testid="val-key">{ValidatedGrid.__rsc_ls_key}</code>
      </p>
      <p>
        control{" "}
        <span data-testid="grid-control">{control?.order ?? "none"}</span>
      </p>
      <Link
        to={`${basePath}?written=1`}
        state={[
          VersionedGrid(grid),
          ValidatedGrid(grid),
          ListSort({ order: "control" }),
        ]}
        data-testid="grid-write"
      >
        Write grid state
      </Link>
    </section>
  );
}
