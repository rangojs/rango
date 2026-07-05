"use client";

import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import type { PprExecCounters } from "../loaders/ppr-shell.js";

// Execution-matrix consumer (docs/design/shell-fast-path.md): renders the
// loader's per-layer counter snapshot as JSON text so the e2e can parse which
// layers executed on each serve straight out of the streamed document body.
export function PprShellExecMatrix({
  loader,
}: {
  loader: LoaderDefinition<PprExecCounters>;
}) {
  const { data } = useLoader(loader);
  return <div data-testid="ppr-exec-counters">{JSON.stringify(data)}</div>;
}
