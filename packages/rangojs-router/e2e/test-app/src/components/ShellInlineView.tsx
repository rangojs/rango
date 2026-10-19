"use client";

import { Suspense, use } from "react";
import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import type { ShellInlineData } from "../urls/shell-cache-inline.js";

// About 16 KB: past the ~500-byte outlining floor and the 12800-byte default
// progressiveChunkSize on its own, whatever the shell around it.
const GRID_ROWS = 300;

function ShellInlineLive({ value }: { value: Promise<string> }) {
  return <span data-testid="shell-inline-live">{use(value)}</span>;
}

export function ShellInlineView({
  loader,
}: {
  loader: LoaderDefinition<ShellInlineData>;
}) {
  const { data } = useLoader(loader);
  return (
    <>
      <Suspense
        fallback={
          <span data-testid="shell-inline-live-fallback">live pending...</span>
        }
      >
        <ShellInlineLive value={data.live} />
      </Suspense>
      <Suspense
        fallback={
          <div data-testid="shell-inline-grid-skeleton">grid pending...</div>
        }
      >
        <ul data-testid="shell-inline-grid">
          {Array.from({ length: GRID_ROWS }, (_, i) => (
            <li key={i}>{`tile ${i}, in place past the outlining budget`}</li>
          ))}
        </ul>
      </Suspense>
    </>
  );
}
