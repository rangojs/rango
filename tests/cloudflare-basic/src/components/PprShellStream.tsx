"use client";

import { Suspense, use } from "react";
import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import type { PprShellStreamData } from "../loaders/ppr-shell.js";

// Loader-carried promise consumer (docs/design/ppr-shell-resume.md). useLoader
// resolves the loader's OUTER value (label); the nested pendingData promise is
// use()d under this component's OWN inner Suspense, so it becomes a second
// streaming layer. Under a PPR hole (loading() route) the HIT resume streams:
// cached shell -> this outer div + the inner fallback -> the inner value + $RC.
// Reused verbatim by the no-loading() route, where the same inner promise still
// streams progressively under axis 1 even though the shell never caches.
function InnerReader({ promise }: { promise: Promise<string> }) {
  const value = use(promise);
  return <span data-testid="ppr-stream-inner">{value}</span>;
}

export function PprShellStream({
  loader,
}: {
  loader: LoaderDefinition<PprShellStreamData>;
}) {
  const { data } = useLoader(loader);
  return (
    <div data-testid="ppr-stream">
      <div data-testid="ppr-stream-outer">{data.label}</div>
      <Suspense
        fallback={
          <div data-testid="ppr-stream-inner-fallback">Loading inner...</div>
        }
      >
        <InnerReader promise={data.pendingData} />
      </Suspense>
    </div>
  );
}
