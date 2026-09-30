"use client";

import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import type { ShellSharedStampData } from "../urls/shell-cache.defs.js";

// A stamp of the shared-key fixture: the live hole's loader reads the same
// cached item the shell layout read, and renders what the store holds on this
// request; the ssr: false loader's stamp is the capture's, served from its pin.
export function ShellSharedStamp({
  loader,
  testId = "shell-shared-hole",
}: {
  loader: LoaderDefinition<ShellSharedStampData>;
  testId?: string;
}) {
  const {
    data: { stamp },
  } = useLoader(loader);
  return <p data-testid={testId}>{stamp}</p>;
}
