"use client";

import { useLoader, useNavigation, useRouter } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import { navIdleOverlapAction } from "../actions/nav-idle-overlap.js";

declare global {
  interface Window {
    /** What the controls did, with the server's tags on screen at that moment. */
    __navIdleOverlap?: { event: string; tags: string; search: string }[];
  }
}

function record(event: string): void {
  (window.__navIdleOverlap ??= []).push({
    event,
    tags:
      document.querySelector('[data-testid="nav-idle-server-tags"]')
        ?.textContent ?? "",
    search: window.location.search,
  });
}

/**
 * Work that overlaps a held filter navigation on /nav-idle-overlap: a server
 * action, a newer navigation that the server answers with an external
 * redirect (no page commits for it), and a newer navigation to another page.
 */
export function NavIdleOverlapControls({
  away,
  newer,
}: {
  away: string;
  newer: string;
}): React.ReactNode {
  const router = useRouter();
  return (
    <div>
      <button
        type="button"
        data-testid="nav-idle-action"
        onClick={() => {
          record("action-start");
          void navIdleOverlapAction().then(() => record("action-settled"));
        }}
      >
        action
      </button>
      <button
        type="button"
        data-testid="nav-idle-away"
        onClick={() => {
          record("away");
          void router.push(away);
        }}
      >
        away
      </button>
      <button
        type="button"
        data-testid="nav-idle-newer"
        onClick={() => {
          record("newer");
          void router.push(newer);
        }}
      >
        newer
      </button>
    </div>
  );
}

const searchOf = (url: string | null): string =>
  url === null ? "" : new URL(url, "http://localhost").search;

/**
 * useNavigation()'s location and pendingUrl, through the full state and
 * through selectors: location is the page on screen, pendingUrl the page
 * being fetched.
 */
export function NavIdleLocation(): React.ReactNode {
  const nav = useNavigation();
  const selected = useNavigation((n) => n.location.href);
  return (
    <p
      data-testid="nav-idle-location"
      data-location={nav.location.search}
      data-selected-location={searchOf(selected)}
      data-pending-url={searchOf(nav.pendingUrl)}
    >
      {`${nav.location.search} ${searchOf(nav.pendingUrl)}`}
    </p>
  );
}

/**
 * The page's tags, read from its loader on the client: a navigation commits
 * before the loader answers, and React holds that commit until it does.
 */
export function NavIdleServerTags({
  loader,
}: {
  loader: LoaderDefinition<string[]>;
}): React.ReactNode {
  const { data } = useLoader(loader);
  return <p data-testid="nav-idle-server-tags">{data.join(",") || "none"}</p>;
}
