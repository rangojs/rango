"use client";

import { use } from "react";
import { Link, useHandle } from "@rangojs/router/client";
import { ShellStaleReplayHandle } from "../urls/shell-cache.defs.js";

interface ShellStaleReplayProps {
  data: Promise<string>;
  handle: typeof ShellStaleReplayHandle;
  search: string;
}

export function ShellStaleReplay({
  data,
  handle,
  search,
}: ShellStaleReplayProps) {
  const value = use(data);
  const handles = useHandle(handle) ?? [];

  return (
    <main data-testid="shell-stale-replay-page">
      <p data-testid="shell-stale-replay-data">{value}</p>
      <p data-testid="shell-stale-replay-handles">{JSON.stringify(handles)}</p>
      <Link
        to={`/shell-cache/stale-replay/1${search}`}
        data-testid="shell-stale-replay-1"
        prefetch="none"
      >
        Go to stale replay 1
      </Link>
      <Link
        to={`/shell-cache/stale-replay/2${search}`}
        data-testid="shell-stale-replay-2"
        prefetch="none"
      >
        Go to stale replay 2
      </Link>
    </main>
  );
}
