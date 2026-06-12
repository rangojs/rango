"use client";

import { useTransition } from "react";
import { invalidateClientCache } from "@rangojs/router";
import { actionKeepCache, actionKeepThenInvalidate } from "../actions.jsx";

export function InvalidateClientCacheButton() {
  // Client seat: a mutation the router can't see (e.g. a REST/WebSocket push).
  return (
    <button
      data-testid="invalidate-client-btn"
      onClick={() => invalidateClientCache()}
    >
      Invalidate (client seat)
    </button>
  );
}

export function ActionKeepCacheButton() {
  const [isPending, startTransition] = useTransition();

  return (
    <button
      data-testid="action-keep-cache-btn"
      disabled={isPending}
      onClick={() => startTransition(() => actionKeepCache())}
    >
      {isPending ? "Keeping..." : "Keep Cache via Action"}
    </button>
  );
}

export function ActionKeepThenInvalidateButton() {
  const [isPending, startTransition] = useTransition();

  return (
    <button
      data-testid="action-keep-then-invalidate-btn"
      disabled={isPending}
      onClick={() => startTransition(() => actionKeepThenInvalidate())}
    >
      {isPending ? "Working..." : "Keep + Invalidate via Action"}
    </button>
  );
}
