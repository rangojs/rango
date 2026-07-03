"use client";

import { Suspense, use } from "react";
import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import type { ShellStreamData } from "../urls/shell-cache.defs.js";

// Loader-carried promise consumer (docs/design/ppr-shell-resume.md). useLoader
// resolves the loader's OUTER value (label); the nested pendingData promise is
// use()d under this component's OWN inner Suspense, a second streaming layer.
// Under a PPR hole (loading() route) the HIT resume streams: cached shell ->
// outer div + inner fallback -> inner value + $RC. Reused verbatim by the
// no-loading() route, where the same inner promise still streams under axis 1.
function InnerReader({ promise }: { promise: Promise<string> }) {
  const value = use(promise);
  return <span data-testid="shell-stream-inner">{value}</span>;
}

export function ShellCacheStream({
  loader,
}: {
  loader: LoaderDefinition<ShellStreamData>;
}) {
  const { data } = useLoader(loader);
  return (
    <div data-testid="shell-stream">
      <div data-testid="shell-stream-outer">{data.label}</div>
      <Suspense
        fallback={
          <div data-testid="shell-stream-inner-fallback">Loading inner...</div>
        }
      >
        <InnerReader promise={data.pendingData} />
      </Suspense>
    </div>
  );
}
