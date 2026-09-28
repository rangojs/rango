"use client";

import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import type { ShellSharedStampData } from "../urls/shell-cache.defs.js";

// The live hole of the shared-key fixture: the loader reads the same cached
// item the shell layout read, and renders what the store holds on this request.
export function ShellSharedStamp({
  loader,
}: {
  loader: LoaderDefinition<ShellSharedStampData>;
}) {
  const {
    data: { stamp },
  } = useLoader(loader);
  return <p data-testid="shell-shared-hole">{stamp}</p>;
}
