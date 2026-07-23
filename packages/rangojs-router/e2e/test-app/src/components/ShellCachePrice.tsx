"use client";

import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import type { ShellPriceData } from "../urls/shell-cache.defs.js";

// The dynamic hole. Reads the live loader via useLoader, so it suspends until the
// loader streams in. Wrapped in a <Suspense> by the page, it is the only part of
// the route that postpones during shell capture and resumes on a HIT. data-seq
// advances every request even though the shell above it is served from the cached
// prelude.
export function ShellCachePrice({
  loader,
}: {
  loader: LoaderDefinition<ShellPriceData>;
}) {
  const {
    data: { price, seq },
  } = useLoader(loader);
  return (
    <div data-testid="shell-price" data-seq={seq}>
      Live price: ${price} (seq {seq})
    </div>
  );
}
