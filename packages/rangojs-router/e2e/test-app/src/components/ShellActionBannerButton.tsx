"use client";

import { useActionState } from "react";
import { updateBannerAction } from "../actions/shell-cache-action.js";

// 10(b): mutate SHELL material (the cached+tagged banner) and invalidate its tag.
// The banner is frozen into the prelude and the shell auto-carries the tag, so
// after this action a hard GET MISSes (shell dropped by the tag cascade) and
// recaptures with the new banner in the prelude.
export function ShellActionBannerButton() {
  const [state, formAction, isPending] = useActionState(
    updateBannerAction,
    null,
  );
  return (
    <form action={formAction} data-testid="shell-action-banner-form">
      <button
        type="submit"
        disabled={isPending}
        data-testid="shell-action-banner-btn"
      >
        Update banner
      </button>
      {state && (
        <span data-testid="shell-action-banner-result">
          updated: {state.banner}
        </span>
      )}
    </form>
  );
}
