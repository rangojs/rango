"use client";

import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import type { PprShellPriceData } from "../loaders/ppr-shell.js";

// The dynamic hole. Reads the live loader via useLoader, so it suspends until the
// loader streams in. Wrapped in a <Suspense> by the page, it is the only part of
// the route that postpones during shell capture and resumes on a HIT. data-seq
// advances every request (the loader is always fresh) even though the shell above
// it is served from the cached prelude.
export function PprShellPrice({
  loader,
}: {
  loader: LoaderDefinition<PprShellPriceData>;
}) {
  const {
    data: { price, seq },
  } = useLoader(loader);
  return (
    <div data-testid="ppr-price" data-seq={seq}>
      Live price: ${price} (seq {seq})
    </div>
  );
}
