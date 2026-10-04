"use client";

import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";

export interface PprSharedStampData {
  stamp: string;
}

// A stamp of the shared-key fixture (pages/ppr-drift.tsx): the live hole's
// loader reads the same cached item the shell layout read, and renders what
// the store holds on this request; the ssr: false loader's stamp is the
// capture's, served from its pin.
export function PprSharedStamp({
  loader,
  testId = "ppr-shared-hole",
}: {
  loader: LoaderDefinition<PprSharedStampData>;
  testId?: string;
}) {
  const {
    data: { stamp },
  } = useLoader(loader);
  return <p data-testid={testId}>{stamp}</p>;
}
