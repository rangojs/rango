"use client";

import { useActionState } from "react";

// State returned by an inline "use server" action embedded in a cached value:
// an article (build-time Prerender) or a blog post (runtime cache()). Pins the
// three axes of a cached-embedded action at once:
//   capturedId - the per-item id the action CLOSED OVER (article/blog slug),
//                frozen with the cache/prerender entry (a stable identity).
//   asyncValue - a fresh value the action body computes per invocation (the live
//                "+1" call); differs on every click.
//   user       - a request-scoped cookie read in the body (live request scope).
export type InlineActionState = {
  capturedId: string;
  asyncValue: string;
  user: string;
} | null;

export function InlineLikeButton({
  capturedId,
  action,
}: {
  capturedId: string;
  action: (
    prev: InlineActionState,
    formData: FormData,
  ) => Promise<InlineActionState>;
}) {
  const [state, formAction, isPending] = useActionState<
    InlineActionState,
    FormData
  >(action, null);

  return (
    <form action={formAction} data-testid="inline-like">
      <button
        type="submit"
        data-testid="inline-like-button"
        disabled={isPending}
      >
        Like
      </button>
      <p data-testid="inline-like-captured">
        captured:{state?.capturedId ?? "none"}
      </p>
      <p data-testid="inline-like-async">async:{state?.asyncValue ?? "none"}</p>
      <p data-testid="inline-like-user">user:{state?.user ?? "none"}</p>
    </form>
  );
}
