"use client";

import { useActionState } from "react";
import {
  onDemandPlainAction,
  type OnDemandActionState,
} from "../actions/on-demand-action.js";

function ActionForm({ slug, refresh }: { slug: string; refresh: boolean }) {
  const [state, formAction, isPending] = useActionState<
    OnDemandActionState | null,
    FormData
  >(onDemandPlainAction, null);
  const id = refresh ? "od-action-refresh" : "od-action-noop";
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
export function OnDemandActionPanel({ slug }: { slug: string }) {
  return (
    <div data-testid="od-action-panel">
      <ActionForm slug={slug} refresh={false} />
      <ActionForm slug={slug} refresh />
    </div>
  );
}
