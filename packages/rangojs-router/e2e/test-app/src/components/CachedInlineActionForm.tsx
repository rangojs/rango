"use client";

import { useActionState } from "react";

// State returned by an inline "use server" action that was CREATED INSIDE a
// "use cache" server component. It pins three distinct freshness behaviors of a
// cached-embedded action at once:
//
//   capturedToken - a render-scope value the action CLOSED OVER. The closure is
//     compiled to an encrypted bound arg snapshotted at cache-WRITE time, so it
//     is FROZEN: on a cache hit there is no re-render and the action replays the
//     write-time value (identical to the cached rendered token).
//   asyncValue - the result of a plain (non-cached) async function the action
//     calls in its body. The body runs LIVE on every invocation, so this value
//     differs on every call.
//   sessionCookie - a request-scoped cookie read via cookies() in the action
//     body. The body runs in the LIVE POST request context, so this reflects the
//     CURRENT request's cookie, not the cached render's scope.
//
// This form invokes the action so a test can compare all three against the
// rendered (cached) token and pin the contract in dev and prod.
export type CachedInlineActionState = {
  capturedToken: string;
  asyncValue: string;
  sessionCookie: string;
} | null;

export function CachedInlineActionForm({
  renderedToken,
  cachedAction,
}: {
  renderedToken: string;
  cachedAction: (
    prev: CachedInlineActionState,
    formData: FormData,
  ) => Promise<CachedInlineActionState>;
}) {
  const [state, formAction, isPending] = useActionState<
    CachedInlineActionState,
    FormData
  >(cachedAction, null);

  return (
    <div data-testid="cached-inline-action-page">
      <p data-testid="cached-inline-rendered-token">rendered:{renderedToken}</p>
      <form action={formAction} data-testid="cached-inline-action-form">
        <button
          type="submit"
          data-testid="cached-inline-action-submit"
          disabled={isPending}
        >
          Invoke Cached Inline Action
        </button>
        <p data-testid="cached-inline-captured-token">
          captured:{state?.capturedToken ?? "none"}
        </p>
        <p data-testid="cached-inline-async-value">
          async:{state?.asyncValue ?? "none"}
        </p>
        <p data-testid="cached-inline-session-cookie">
          session:{state?.sessionCookie ?? "none"}
        </p>
      </form>
    </div>
  );
}
