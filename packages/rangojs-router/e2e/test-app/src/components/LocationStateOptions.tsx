"use client";

import { useEffect, useState } from "react";
import {
  Link,
  useLoader,
  useLocationState,
  useNavigation,
  usePathname,
  useRouter,
  useSearchParams,
} from "@rangojs/router/client";
import {
  CarriedItems,
  GridState,
  ListSort,
  ServerPageStamp,
} from "../location-states.js";
import { LoadMoreLoader } from "../urls/location-state.loader.js";

/**
 * #1031: the URL as usePathname and useSearchParams report it,
 * `<pathname>?<search>`. The readers of this file show it next to the page
 * they are in, so a URL that moved without its page is on screen.
 */
function useShownUrl(): string {
  const pathname = usePathname();
  const [search] = useSearchParams();
  return `${pathname}?${search}`;
}

/** The same form for a URL useNavigation() reports, absolute or relative. */
function shownUrlOf(url: string | URL): string {
  const { pathname, searchParams } = new URL(url, "http://relative");
  return `${pathname}?${searchParams}`;
}

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
 *
 * `lm-more-cold` is the same link to a URL of its own (`&cold=1`) that is
 * never prefetched. An app that prefetches keeps a prefetched response for
 * its TTL and serves a return to that URL from it; the entry this link
 * creates can only come back from the history cache or the server (#1030).
 *
 * `lm-push-cold` is that navigation through `router.push`.
 *
 * `lm-url` is the URL the list reads from usePathname and useSearchParams,
 * `lm-late-url` the one the late reader reads (#1031): each has to name the
 * page it is shown in.
 */
export function LoadMoreList({ basePath }: { basePath: string }) {
  const carried = useLocationState(CarriedItems) ?? [];
  const sort = useLocationState(ListSort);
  const serverStamp = useLocationState(ServerPageStamp);
  const { data } = useLoader(LoadMoreLoader);
  const [search] = useSearchParams();
  const hold = search.get("hold");
  const url = useShownUrl();
  const router = useRouter();
  const [late, setLate] = useState(false);
  const shown = [...carried, ...data.items];
  const coldNext = `${basePath}?page=${data.page + 1}&cold=1${hold ? `&hold=${hold}` : ""}`;
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
        <span data-testid="lm-server-page">{serverStamp?.page ?? "none"}</span>,
        url <span data-testid="lm-url">{url}</span>
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
      </Link>{" "}
      <Link
        to={coldNext}
        state={[CarriedItems(shown), ListSort({ order: "asc" })]}
        scroll={false}
        prefetch="none"
        data-testid="lm-more-cold"
      >
        Load more, never prefetched
      </Link>{" "}
      <button
        type="button"
        data-testid="lm-push-cold"
        onClick={() =>
          router.push(coldNext, {
            state: [CarriedItems(shown), ListSort({ order: "asc" })],
            scroll: false,
          })
        }
      >
        Load more, router.push
      </button>
    </section>
  );
}

/**
 * `<page of the list it mounted in>:<carried items it reads>`, and the URL it
 * reads (#1031).
 */
function LateCarried({ page }: { page: number }) {
  const carried = useLocationState(CarriedItems) ?? [];
  const url = useShownUrl();
  return (
    <p>
      <span data-testid="lm-late">{`${page}:${carried.length}`}</span>, url{" "}
      <span data-testid="lm-late-url">{url}</span>
    </p>
  );
}

/**
 * #1029: a CarriedItems reader in the layout both fixtures of this file share,
 * so it stays mounted across a navigation between them. It shows how many
 * items the entry carries: more than none only together with the list.
 *
 * #1031: the same for the URL (`ls-shared-url`), and what useNavigation()
 * reports while a navigation is pending (`ls-shared-nav`):
 * `<state>|<streaming or settled>|<location>|<pendingUrl or none>`.
 */
export function SharedCarriedCount() {
  const carried = useLocationState(CarriedItems) ?? [];
  const url = useShownUrl();
  const nav = useNavigation();
  return (
    <p>
      shared layout, carried{" "}
      <span data-testid="ls-shared-carried">{carried.length}</span>, url{" "}
      <span data-testid="ls-shared-url">{url}</span>, navigation{" "}
      <span data-testid="ls-shared-nav">
        {[
          nav.state,
          nav.isStreaming ? "streaming" : "settled",
          shownUrlOf(nav.location),
          nav.pendingUrl ? shownUrlOf(nav.pendingUrl) : "none",
        ].join("|")}
      </span>
    </p>
  );
}

/** #1031: a URL reader the panel mounts on demand (`grid-open-late`). */
function LateUrl() {
  return <p data-testid="grid-late-url">{useShownUrl()}</p>;
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
 *
 * #1031: `grid-url` is the URL the panel reads, and `grid-open-late` mounts a
 * second URL reader in it (`grid-late-url`), as `lm-open-late` does in the
 * list.
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
  const url = useShownUrl();
  const [mounted, setMounted] = useState(false);
  const [late, setLate] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <section>
      <p>
        step <span data-testid="grid-step">{step}</span>, mounted{" "}
        <span data-testid="grid-mounted">{mounted ? "yes" : "no"}</span>, url{" "}
        <span data-testid="grid-url">{url}</span>
      </p>
      <button
        type="button"
        data-testid="grid-open-late"
        onClick={() => setLate(true)}
      >
        Mount a late reader
      </button>
      {late && <LateUrl />}
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
