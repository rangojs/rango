"use client";

import { clientUrls, useLoader, useOutlet } from "@rangojs/router/client";
import { bumpClientUrlsCounter } from "../actions.jsx";
import {
  ClientUrlsCounterLoader,
  ClientUrlsSessionLoader,
} from "./client-urls.loader.js";

/**
 * clientUrls() group pinning ACTION revalidation semantics. Loaders are
 * declared at the client LAYOUT level, so they reach the route record via the
 * DSL's flatten (the group's loaders are the route's server-side material).
 * After the server action bumps the shared counter, the follow-up render:
 * - revalidates ClientUrlsCounterLoader (locked default: true on actions);
 * - SKIPS ClientUrlsSessionLoader — its CLIENT-RUN revalidate() below opts
 *   out of action revalidation, and only that decision crosses the wire;
 * - keeps the parent RSC layout in urls.tsx (reads the SAME counter) on the
 *   locked parent-chain skip.
 * Three freshness outcomes from one counter in one commit.
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
  const { data: session } = useLoader(ClientUrlsSessionLoader);

  return (
    <div data-testid="ca-index">
      <span data-testid="ca-loader">{data}</span>
      <span data-testid="ca-session">{session}</span>
      <button
        data-testid="ca-bump"
        onClick={() => void bumpClientUrlsCounter()}
      >
        Bump counter
      </button>
    </div>
  );
}

export default clientUrls(({ layout, path, loader, revalidate }) => [
  layout(ActionClientLayout, () => [
    loader(ClientUrlsCounterLoader),
    loader(ClientUrlsSessionLoader, () => [
      revalidate(({ isAction, defaultShouldRevalidate }) =>
        isAction ? false : defaultShouldRevalidate,
      ),
    ]),
    path("/", ActionClientIndex, { name: "index" }),
  ]),
]);
