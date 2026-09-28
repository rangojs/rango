"use client";

import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";

export interface PprSharedStampData {
  stamp: string;
}

// The live hole of the shared-key fixture (pages/ppr-drift.tsx): the loader
// reads the same cached item the shell layout read, and renders what the store
// holds on this request.
export function PprSharedStamp({
  loader,
}: {
  loader: LoaderDefinition<PprSharedStampData>;
}) {
  const {
    data: { stamp },
  } = useLoader(loader);
  return <p data-testid="ppr-shared-hole">{stamp}</p>;
}
