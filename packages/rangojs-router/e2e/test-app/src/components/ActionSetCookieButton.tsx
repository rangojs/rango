"use client";

import { useTransition } from "react";
import { actionSetSessionCookie } from "../actions.jsx";

export function ActionSetCookieButton() {
  const [isPending, startTransition] = useTransition();

  return (
    <button
      data-testid="action-set-cookie-btn"
      disabled={isPending}
      onClick={() => startTransition(() => actionSetSessionCookie())}
    >
      {isPending ? "Setting..." : "Set Cookie via Action"}
    </button>
  );
}
