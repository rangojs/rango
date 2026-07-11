"use client";

import { useActionState } from "react";
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

export interface PprInlineActionState {
  captured: string;
  submitted: string;
}

export function PprInlineActionForm({
  action,
  renderedCaptured,
}: {
  action: (
    previous: PprInlineActionState,
    formData: FormData,
  ) => Promise<PprInlineActionState>;
  renderedCaptured: string;
}) {
  const [state, formAction] = useActionState(action, {
    captured: "none",
    submitted: "none",
  });

  return (
    <form action={formAction} data-testid="ppr-inline-action-page">
      <p data-testid="ppr-inline-action-rendered">
        {`rendered:${renderedCaptured}`}
      </p>
      <input name="value" defaultValue="from-client" />
      <button type="submit" data-testid="ppr-inline-action-submit">
        Submit
      </button>
      <p data-testid="ppr-inline-action-captured">
        {`captured:${state.captured}`}
      </p>
      <p data-testid="ppr-inline-action-submitted">
        {`submitted:${state.submitted}`}
      </p>
    </form>
  );
}
