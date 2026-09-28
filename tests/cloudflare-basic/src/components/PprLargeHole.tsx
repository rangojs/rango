"use client";

import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";

// Live hole under the large PPR shell (pages/ppr-large.tsx): suspends to the
// page's inline <Suspense> until the loader streams in; seq advances per request.
export function PprLargeHole({
  loader,
}: {
  loader: LoaderDefinition<{ seq: number }>;
}) {
  const {
    data: { seq },
  } = useLoader(loader);
  return (
    <div data-testid="ppr-large-hole" data-seq={seq}>
      Live hole (seq {seq})
    </div>
  );
}
