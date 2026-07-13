"use client";

import { Suspense, use, useActionState } from "react";
import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import { submitPrerenderPprAction } from "../actions/shell-cache-action.js";

// State returned by the closure-capturing inline action. `captured` is the
// render-scope value the server component closed over (a bound argument that
// rides through encryptActionBoundArgs/decryptActionBoundArgs in production);
// `streamed` stays pending after the action's top-level result arrives.
export interface InlineBoundResult {
  captured: string;
  submitted: string;
  streamed: Promise<string>;
}

export type InlineBoundState = InlineBoundResult | null;

export interface InlineBoundPageHoleData {
  pendingData: Promise<string>;
}

function PendingText({
  promise,
  testId,
}: {
  promise: Promise<string>;
  testId: string;
}) {
  return <p data-testid={testId}>{use(promise)}</p>;
}

export function InlineBoundActionForm({
  boundAction,
  pageHoleLoader,
}: {
  boundAction: (
    prev: InlineBoundState,
    formData: FormData,
  ) => Promise<InlineBoundState>;
  pageHoleLoader: LoaderDefinition<InlineBoundPageHoleData>;
}) {
  const { data: pageHole } = useLoader(pageHoleLoader);
  const [state, formAction, isPending] = useActionState<
    InlineBoundState,
    FormData
  >(boundAction, null);

  return (
    <div data-testid="inline-bound-action-matrix">
      <Suspense
        fallback={
          <p data-testid="inline-bound-page-hole-fallback">
            Page hole pending...
          </p>
        }
      >
        <PendingText
          promise={pageHole.pendingData}
          testId="inline-bound-page-hole-result"
        />
      </Suspense>

      <form action={formAction} data-testid="inline-bound-action-form">
        <input
          type="text"
          name="submitted"
          defaultValue="from-client"
          data-testid="inline-bound-action-input"
        />
        <button
          type="submit"
          data-testid="inline-bound-action-submit"
          disabled={isPending}
        >
          {isPending ? "Processing..." : "Submit Bound Inline Action"}
        </button>
        <p data-testid="inline-bound-action-captured">
          captured:{state?.captured ?? "none"}
        </p>
        <p data-testid="inline-bound-action-submitted">
          submitted:{state?.submitted ?? "none"}
        </p>
        {state?.streamed && (
          <Suspense
            fallback={
              <p data-testid="inline-bound-action-stream-fallback">
                Streaming action result...
              </p>
            }
          >
            <PendingText
              promise={state.streamed}
              testId="inline-bound-action-stream-result"
            />
          </Suspense>
        )}
      </form>
    </div>
  );
}

export function PrerenderPprActionForm() {
  const [state, formAction, isPending] = useActionState(
    submitPrerenderPprAction,
    null,
  );

  return (
    <form action={formAction} data-testid="prerender-ppr-action-form">
      <input name="value" defaultValue="from-client" />
      <button
        type="submit"
        disabled={isPending}
        data-testid="prerender-ppr-action-submit"
      >
        {isPending ? "Submitting..." : "Submit prerender action"}
      </button>
      {state && (
        <Suspense
          fallback={
            <p data-testid="prerender-ppr-action-fallback">
              Streaming prerender action result...
            </p>
          }
        >
          <PendingText
            promise={state.streamed}
            testId="prerender-ppr-action-result"
          />
        </Suspense>
      )}
    </form>
  );
}
