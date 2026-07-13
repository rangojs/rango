"use client";

import { Suspense, use, useActionState } from "react";
import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import type {
  PprExecCounters,
  PprInlineActionHoleData,
} from "../loaders/ppr-shell.js";
import { submitPrerenderPprAction } from "../actions/counter.js";

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
  streamed: Promise<string> | null;
}

function PprPendingText({
  promise,
  testId,
}: {
  promise: Promise<string>;
  testId: string;
}) {
  return <p data-testid={testId}>{use(promise)}</p>;
}

export function PprInlineActionForm({
  action,
  renderedCaptured,
  pageHoleLoader,
}: {
  action: (
    previous: PprInlineActionState,
    formData: FormData,
  ) => Promise<PprInlineActionState>;
  renderedCaptured: string;
  pageHoleLoader: LoaderDefinition<PprInlineActionHoleData>;
}) {
  const { data: pageHole } = useLoader(pageHoleLoader);
  const [state, formAction, isPending] = useActionState(action, {
    captured: "none",
    submitted: "none",
    streamed: null,
  });

  return (
    <div data-testid="ppr-inline-action-page">
      <Suspense
        fallback={
          <p data-testid="ppr-inline-page-hole-fallback">
            CF page hole pending...
          </p>
        }
      >
        <PprPendingText
          promise={pageHole.pendingData}
          testId="ppr-inline-page-hole-result"
        />
      </Suspense>

      <form action={formAction} data-testid="ppr-inline-action-form">
        <p data-testid="ppr-inline-action-rendered">
          {`rendered:${renderedCaptured}`}
        </p>
        <input name="value" defaultValue="from-client" />
        <button type="submit" data-testid="ppr-inline-action-submit">
          {isPending ? "Processing..." : "Submit"}
        </button>
        <p data-testid="ppr-inline-action-captured">
          {`captured:${state.captured}`}
        </p>
        <p data-testid="ppr-inline-action-submitted">
          {`submitted:${state.submitted}`}
        </p>
        {state.streamed && (
          <Suspense
            fallback={
              <p data-testid="ppr-inline-action-stream-fallback">
                Streaming action result...
              </p>
            }
          >
            <PprPendingText
              promise={state.streamed}
              testId="ppr-inline-action-stream-result"
            />
          </Suspense>
        )}
      </form>
    </div>
  );
}

export function PprPrerenderActionForm() {
  const [state, formAction, isPending] = useActionState(
    submitPrerenderPprAction,
    null,
  );

  return (
    <form action={formAction} data-testid="ppr-prerender-action-form">
      <input name="value" defaultValue="from-client" />
      <button
        type="submit"
        disabled={isPending}
        data-testid="ppr-prerender-action-submit"
      >
        {isPending ? "Submitting..." : "Submit prerender action"}
      </button>
      {state && (
        <Suspense
          fallback={
            <p data-testid="ppr-prerender-action-fallback">
              Streaming prerender action result...
            </p>
          }
        >
          <PprPendingText
            promise={state.streamed}
            testId="ppr-prerender-action-result"
          />
        </Suspense>
      )}
    </form>
  );
}
