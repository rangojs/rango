"use client";

import { useActionState } from "react";

// State returned by the closure-capturing inline action. `captured` is the
// render-scope value the server component closed over (a bound argument that
// rides through encryptActionBoundArgs/decryptActionBoundArgs in production);
// `submitted` echoes the form input so we can assert both round-trip.
export type InlineBoundState = {
  captured: string;
  submitted: string;
} | null;

export function InlineBoundActionForm({
  boundAction,
}: {
  boundAction: (
    prev: InlineBoundState,
    formData: FormData,
  ) => Promise<InlineBoundState>;
}) {
  const [state, formAction, isPending] = useActionState<
    InlineBoundState,
    FormData
  >(boundAction, null);

  return (
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
        Submit Bound Inline Action
      </button>
      <p data-testid="inline-bound-action-captured">
        captured:{state?.captured ?? "none"}
      </p>
      <p data-testid="inline-bound-action-submitted">
        submitted:{state?.submitted ?? "none"}
      </p>
    </form>
  );
}
