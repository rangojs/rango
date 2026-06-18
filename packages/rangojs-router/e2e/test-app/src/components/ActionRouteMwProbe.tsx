"use client";

import { useTransition } from "react";
import { actionRouteMwSuccess, actionRouteMwThrow } from "../actions.js";

/**
 * Action error-boundary + route-middleware probe (C3). Two buttons: one fires a
 * succeeding action (revalidation render), one fires a throwing action (error
 * boundary render). The e2e intercepts each action's POST response and asserts
 * the route-middleware header is present on BOTH — proving the error-boundary
 * render runs under route middleware, like the success render.
 */
export function ActionRouteMwProbe() {
  const [pending, startTransition] = useTransition();

  return (
    <div data-testid="action-route-mw-probe">
      <button
        data-testid="action-route-mw-success-btn"
        disabled={pending}
        onClick={() => startTransition(() => actionRouteMwSuccess())}
      >
        Success Action
      </button>
      <button
        data-testid="action-route-mw-throw-btn"
        disabled={pending}
        onClick={() =>
          startTransition(() => actionRouteMwThrow().catch(() => {}))
        }
      >
        Throw Action
      </button>
    </div>
  );
}
