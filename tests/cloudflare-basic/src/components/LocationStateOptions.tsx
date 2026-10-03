"use client";

import { useEffect, useState } from "react";
import {
  Link,
  useLoader,
  useLocationState,
  useSearchParams,
} from "@rangojs/router/client";
import {
  CarriedItems,
  GridState,
  ListSort,
  ServerPageStamp,
} from "../location-states.js";
import { LoadMoreLoader } from "../loaders/location-state.js";

/**
 * #994 / #1029 "load more". LoadMoreLoader loads the page the URL names; the
 * pages already on screen arrive as CarriedItems (clearOnReload) on the Link.
 * After a client navigation both are shown; after a document load only the
 * loader's page, as the server rendered it. ServerPageStamp is the state the
 * route's handler sets on every request.
 *
 * `shown` is the plain concatenation: an entry's carried items change in the
 * commit that brings that entry's page, so no item appears twice while a
 * navigation is pending. Every committed list is pushed to
 * `window.__loadMoreCommits` (as `<page>:<items>`) for the e2e to check the
 * commits it could not sample.
 *
 * `lm-open-late` mounts a second CarriedItems reader (LateCarried) on demand:
 * pressed while a navigation is pending, it mounts in the page still on
 * screen and has to read that page's entry, like the readers around it.
 */
export function LoadMoreList({ basePath }: { basePath: string }) {
  const carried = useLocationState(CarriedItems) ?? [];
  const sort = useLocationState(ListSort);
  const serverStamp = useLocationState(ServerPageStamp);
  const { data } = useLoader(LoadMoreLoader);
  const [search] = useSearchParams();
  const hold = search.get("hold");
  const [late, setLate] = useState(false);
  const shown = [...carried, ...data.items];
  const commit = `${data.page}:${shown.join(",")}`;
  useEffect(() => {
    const log = ((
      window as { __loadMoreCommits?: string[] }
    ).__loadMoreCommits ??= []);
    if (log.at(-1) !== commit) log.push(commit);
  });
  return (
    <section>
      <p>
        page <span data-testid="lm-page">{data.page}</span>, carried{" "}
        <span data-testid="lm-carried-count">{carried.length}</span>, sort{" "}
        <span data-testid="lm-sort">{sort?.order ?? "none"}</span>, server stamp{" "}
        <span data-testid="lm-server-page">{serverStamp?.page ?? "none"}</span>
      </p>
      <button
        type="button"
        data-testid="lm-open-late"
        onClick={() => setLate(true)}
      >
        Mount a late reader
      </button>
      {late && <LateCarried page={data.page} />}
      <ul data-testid="lm-items">
        {shown.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <Link
        to={`${basePath}?page=${data.page + 1}${hold ? `&hold=${hold}` : ""}`}
        state={[CarriedItems(shown), ListSort({ order: "asc" })]}
        scroll={false}
        data-testid="lm-more"
      >
        Load more
      </Link>
    </section>
  );
}

/** `<page of the list it mounted in>:<carried items it reads>`. */
function LateCarried({ page }: { page: number }) {
  const carried = useLocationState(CarriedItems) ?? [];
  return <p data-testid="lm-late">{`${page}:${carried.length}`}</p>;
}

/**
 * #1029: a CarriedItems reader in the layout both fixtures of this file share,
 * so it stays mounted across a navigation between them. It shows how many
 * items the entry carries: more than none only together with the list.
 */
export function SharedCarriedCount() {
  const carried = useLocationState(CarriedItems) ?? [];
  return (
    <p>
      shared layout, carried{" "}
      <span data-testid="ls-shared-carried">{carried.length}</span>
    </p>
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
