"use client";

import { useState, useTransition } from "react";
import {
  setCookieAction,
  deleteCookieAction,
} from "../actions/cookie-overlay.js";

interface Props {
  mwCookie: string | null;
  actionCookie: string | null;
  deletedCookie: string | null;
}

export function CookieOverlayTest({
  mwCookie,
  actionCookie,
  deletedCookie,
}: Props) {
  const [mwReadByAction, setMwReadByAction] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <div data-testid="cookie-overlay-test">
      <div data-testid="mw-cookie">{mwCookie ?? "none"}</div>
      <div data-testid="action-cookie">{actionCookie ?? "none"}</div>
      <div data-testid="deleted-cookie">{deletedCookie ?? "none"}</div>
      <div data-testid="mw-read-by-action">{mwReadByAction ?? "none"}</div>
      {isPending && <div data-testid="pending">pending</div>}

      <button
        data-testid="set-cookie-btn"
        onClick={() =>
          startTransition(async () => {
            const result = await setCookieAction();
            setMwReadByAction(result);
          })
        }
      >
        Set Cookie
      </button>

      <button
        data-testid="delete-cookie-btn"
        onClick={() =>
          startTransition(async () => {
            await deleteCookieAction();
          })
        }
      >
        Delete Cookie
      </button>
    </div>
  );
}
