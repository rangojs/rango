"use client";

import { Suspense, use } from "react";
import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import type { PprInlineData } from "../loaders/ppr-inline.js";

// About 16 KB: past the ~500-byte outlining floor and the 12800-byte default
// progressiveChunkSize on its own, whatever the shell around it.
const GRID_ROWS = 300;

function PprInlineLive({ value }: { value: Promise<string> }) {
  return <span data-testid="ppr-inline-live">{use(value)}</span>;
}

export function PprInlineView({
  loader,
}: {
  loader: LoaderDefinition<PprInlineData>;
}) {
  const { data } = useLoader(loader);
  return (
    <>
      <Suspense
        fallback={
          <span data-testid="ppr-inline-live-fallback">live pending...</span>
        }
      >
        <PprInlineLive value={data.live} />
      </Suspense>
      <Suspense
        fallback={
          <div data-testid="ppr-inline-grid-skeleton">grid pending...</div>
        }
      >
        <ul data-testid="ppr-inline-grid">
          {Array.from({ length: GRID_ROWS }, (_, i) => (
            <li key={i}>{`tile ${i}, in place past the outlining budget`}</li>
          ))}
        </ul>
      </Suspense>
    </>
  );
}
