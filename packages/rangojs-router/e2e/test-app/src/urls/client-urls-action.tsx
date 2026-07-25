"use client";

import { clientUrls, useLoader, useOutlet } from "@rangojs/router/client";
import { bumpClientUrlsCounter } from "../actions.jsx";
import { ClientUrlsCounterLoader } from "./client-urls.loader.js";

/**
 * clientUrls() group pinning ACTION revalidation semantics. The loader is
 * declared at the client LAYOUT level, so it reaches the route record via the
 * DSL's flatten (the group's loaders are the route's server-side material).
 * After the server action bumps the shared counter, the follow-up render
 * revalidates the route-owned loader (locked default: true on actions) — the
 * useLoader value updates — while the parent RSC layout in urls.tsx reading
 * the SAME counter keeps the parent-chain skip and shows the pre-action value.
 */

function ActionClientLayout() {
  const { content } = useOutlet();

  return (
    <section data-testid="ca-layout">
      <h2>ClientUrls action group</h2>
      {content}
    </section>
  );
}

function ActionClientIndex() {
  const { data } = useLoader(ClientUrlsCounterLoader);

  return (
    <div data-testid="ca-index">
      <span data-testid="ca-loader">{data}</span>
      <button
        data-testid="ca-bump"
        onClick={() => void bumpClientUrlsCounter()}
      >
        Bump counter
      </button>
    </div>
  );
}

export default clientUrls(({ layout, path, loader }) => [
  layout(ActionClientLayout, () => [
    loader(ClientUrlsCounterLoader),
    path("/", ActionClientIndex, { name: "index" }),
  ]),
]);
