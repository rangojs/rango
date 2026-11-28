"use client";

import {
  Breadcrumbs,
  Link,
  Meta,
  useHandle,
  useLoader,
  usePathname,
  useRefreshLoaders,
} from "@rangojs/router/client";
import { bumpLoaderReadHandlesTallySlowly } from "./loader-read-handles.actions.js";
import {
  LoaderReadHandlesChat,
  LoaderReadHandlesTally,
} from "./loader-read-handles.loaders.js";

/** The fixture's crumbs (the app's root layout pushes its own) and title. */
export function LoaderReadHandlesHead() {
  const crumbs = useHandle(Breadcrumbs).filter((crumb) =>
    crumb.href.startsWith("/loader-read-handles"),
  );
  const descriptors = useHandle(Meta) as readonly Record<string, unknown>[];
  const title = descriptors.find((d) => "title" in d)?.title;
  return (
    <header>
      <p data-testid="lrh-title">{typeof title === "string" ? title : ""}</p>
      <ol>
        {crumbs.map((crumb) => (
          <li key={crumb.label} data-testid="lrh-crumb">
            {crumb.label}
          </li>
        ))}
      </ol>
    </header>
  );
}

/**
 * A reader of the chat's loader in the "lrh" refresh group, with a link to the
 * same route under another query (the loader re-runs, the reader stays).
 */
export function LoaderReadHandlesReader() {
  const { data, load } = useLoader(LoaderReadHandlesChat, {
    refreshGroup: "lrh",
  });
  const refresh = useRefreshLoaders();
  const pathname = usePathname();
  return (
    <section>
      <p data-testid="lrh-name">{data.name}</p>
      <button
        data-testid="lrh-refresh"
        onClick={() => refresh("lrh").catch(() => {})}
      >
        Refresh
      </button>
      <button data-testid="lrh-load" onClick={() => load().catch(() => {})}>
        Load
      </button>
      <Link to={`${pathname}?id=2`} data-testid="lrh-next">
        Next
      </Link>
    </section>
  );
}

/**
 * The kept page's tally, and the action that bumps it: the action keeps the
 * chat's loader and re-runs the tally's, which shows once its update commits.
 */
export function LoaderReadHandlesTallyBar() {
  const { data } = useLoader(LoaderReadHandlesTally);
  return (
    <section>
      <p data-testid="lrh-tally">{data.tally}</p>
      <button
        data-testid="lrh-act"
        onClick={() => bumpLoaderReadHandlesTallySlowly().catch(() => {})}
      >
        Act
      </button>
    </section>
  );
}
