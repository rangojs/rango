"use client";

import { useActionState } from "react";
import { invalidateTagAction } from "../actions.jsx";

export function InvalidateTagButton({ tag }: { tag: string }) {
  const [state, formAction, isPending] = useActionState(
    invalidateTagAction,
    null,
  );

  return (
    <div>
      <form action={formAction}>
        <input type="hidden" name="tag" value={tag} />
        <button
          type="submit"
          disabled={isPending}
          data-testid="invalidate-tag-btn"
        >
          {isPending ? "Invalidating..." : `Invalidate "${tag}"`}
        </button>
      </form>
      {state && (
        <span data-testid="invalidate-tag-result">invalidated:{state.tag}</span>
      )}
    </div>
  );
}
