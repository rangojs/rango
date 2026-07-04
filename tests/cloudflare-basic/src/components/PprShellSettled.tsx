"use client";

import { Suspense, use } from "react";
import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import type { PprShellSettledData } from "../loaders/ppr-shell.js";

// Unconditional use() against a promise-shaped container key — the exact
// consumer shape that crashed with React #438 when a HIT overlay handed it the
// recorded raw value instead of a rehydrated promise.
function SettledInner({ data }: { data: PprShellSettledData }) {
  return <span data-testid="ppr-settled-fast">{use(data.fast)}</span>;
}

export function PprShellSettled({
  loader,
}: {
  loader: LoaderDefinition<PprShellSettledData>;
}) {
  const { data } = useLoader(loader);
  return (
    <div data-testid="ppr-settled">
      <span data-testid="ppr-settled-label">{data.label}</span>{" "}
      <Suspense
        fallback={
          <span data-testid="ppr-settled-fallback">fast pending...</span>
        }
      >
        <SettledInner data={data} />
      </Suspense>
    </div>
  );
}
