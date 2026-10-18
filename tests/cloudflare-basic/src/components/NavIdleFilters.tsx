"use client";

import { useLayoutEffect, useState } from "react";
import { useNavigation, useSearchParams } from "@rangojs/router/client";

declare global {
  interface Window {
    /** Every commit of NavIdleFilters: the hooks' values and the chips shown. */
    __navIdleLog?: {
      idle: boolean;
      fullIdle: boolean;
      search: string;
      shown: string;
    }[];
  }
}

/**
 * The filter UI of #1164: it shows the requested tags at once and drops its
 * pending copy when the router is done, which is the committed URL matching
 * the request, or the router idle again after it started (an abort, a
 * failure, a newer navigation). A commit with useNavigation() idle and
 * useSearchParams() still on the old search settles it early and flashes
 * the old chips back. `fullIdle` is the same read through the full state,
 * whose value also changes when the response stream ends.
 */
export function NavIdleFilters(): React.ReactNode {
  const [committed, setSearchParams] = useSearchParams();
  const idle = useNavigation((nav) => nav.state === "idle");
  const fullIdle = useNavigation().state === "idle";
  const [pending, setPending] = useState<string | null>(null);
  const [started, setStarted] = useState(false);

  const search = committed.toString();
  const settled = pending !== null && (pending === search || (started && idle));
  if (settled) {
    setPending(null);
    setStarted(false);
  } else if (pending !== null && !started && !idle) {
    setStarted(true);
  }
  const shown = new URLSearchParams(
    pending !== null && !settled ? pending : search,
  ).getAll("tag");

  useLayoutEffect(() => {
    (window.__navIdleLog ??= []).push({
      idle,
      fullIdle,
      search,
      shown: shown.join(","),
    });
  });

  return (
    <ul
      data-testid="nav-idle-chips"
      data-idle={String(idle)}
      data-full-idle={String(fullIdle)}
    >
      {shown.map((tag) => (
        <li key={tag}>
          {tag}
          <button
            type="button"
            data-testid={`nav-idle-remove-${tag}`}
            onClick={() => {
              const next = new URLSearchParams(search);
              const rest = next.getAll("tag").filter((t) => t !== tag);
              next.delete("tag");
              for (const t of rest) next.append("tag", t);
              setPending(next.toString());
              void setSearchParams(next, { scroll: false });
            }}
          >
            remove
          </button>
        </li>
      ))}
    </ul>
  );
}
