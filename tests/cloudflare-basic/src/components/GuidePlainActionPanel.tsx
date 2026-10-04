"use client";

import { useActionState } from "react";
import {
  guidePlainAction,
  type GuidePlainActionState,
} from "../actions/on-demand.js";

function ActionForm({ slug, refresh }: { slug: string; refresh: boolean }) {
  const [state, formAction, isPending] = useActionState<
    GuidePlainActionState | null,
    FormData
  >(guidePlainAction, null);
  const id = refresh ? "gp-action-refresh" : "gp-action-noop";
  return (
    <form action={formAction}>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="refresh" value={refresh ? "1" : "0"} />
      <button type="submit" data-testid={id} disabled={isPending}>
        {refresh ? "refresh in action" : "noop action"}
      </button>
      <p data-testid={`${id}-status`}>{state?.status ?? "idle"}</p>
    </form>
  );
}

// Rendered inside the plain onDemand payload, so the action fires from a page
// served out of the overlay.
export function GuidePlainActionPanel({ slug }: { slug: string }) {
  return (
    <div data-testid="gp-action-panel">
      <ActionForm slug={slug} refresh={false} />
      <ActionForm slug={slug} refresh />
    </div>
  );
}
