"use client";

import { useLoader, useRouter } from "@rangojs/router/client";
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
 * action, and a newer navigation that the server answers with an external
 * redirect (no page commits for it).
 */
export function NavIdleOverlapControls({
  away,
}: {
  away: string;
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
    </div>
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
