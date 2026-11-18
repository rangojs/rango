"use client";

import {
  Breadcrumbs,
  Meta,
  useHandle,
  useLoader,
  useRefreshLoaders,
} from "@rangojs/router/client";
import { LoaderReadHandlesChat } from "./loader-read-handles.loaders.js";

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

/** A reader of the chat's loader in the "lrh" refresh group. */
export function LoaderReadHandlesReader() {
  const { data, load } = useLoader(LoaderReadHandlesChat, {
    refreshGroup: "lrh",
  });
  const refresh = useRefreshLoaders();
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
    </section>
  );
}
