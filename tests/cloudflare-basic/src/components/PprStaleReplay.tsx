"use client";

import { use } from "react";
import { Link, useHandle } from "@rangojs/router/client";
import { PprStaleReplayHandle } from "../loaders/ppr-shell.js";

interface PprStaleReplayProps {
  data: Promise<string>;
  handle: typeof PprStaleReplayHandle;
  search: string;
}

export function PprStaleReplay({ data, handle, search }: PprStaleReplayProps) {
  const value = use(data);
  const handles = useHandle(handle) ?? [];

  return (
    <main data-testid="ppr-stale-replay-page">
      <p data-testid="ppr-stale-replay-data">{value}</p>
      <p data-testid="ppr-stale-replay-handles">{JSON.stringify(handles)}</p>
      <Link
        to={`/ppr-stale-replay/1${search}`}
        data-testid="ppr-stale-replay-1"
        prefetch="none"
      >
        Go to stale replay 1
      </Link>
      <Link
        to={`/ppr-stale-replay/2${search}`}
        data-testid="ppr-stale-replay-2"
        prefetch="none"
      >
        Go to stale replay 2
      </Link>
    </main>
  );
}
