"use client";

import { Suspense, use } from "react";
import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import type { ShellSettledData } from "../urls/shell-cache.defs.js";

// Unconditional use() against a promise-shaped container key — the exact
// consumer shape that crashed with React #438 when a HIT overlay handed it the
// recorded raw value instead of a rehydrated promise.
function SettledInner({ data }: { data: ShellSettledData }) {
  return <span data-testid="shell-settled-fast">{use(data.fast)}</span>;
}

export function ShellSettledValue({
  loader,
}: {
  loader: LoaderDefinition<ShellSettledData>;
}) {
  const { data } = useLoader(loader);
  return (
    <div data-testid="shell-settled">
      <span data-testid="shell-settled-label">{data.label}</span>{" "}
      <Suspense
        fallback={
          <span data-testid="shell-settled-fallback">fast pending...</span>
        }
      >
        <SettledInner data={data} />
      </Suspense>
    </div>
  );
}
