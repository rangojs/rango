"use client";

import { useTransition } from "react";
import { useLocationState } from "@rangojs/router/client";
import { ActionFlash } from "../location-states.js";
import { setFlash } from "../actions.js";

// Reads location state written by a server action. Initially "none"; after the
// action runs, the action response carries the location state to the client.
export function Flash() {
  const flash = useLocationState(ActionFlash);
  const [isPending, startTransition] = useTransition();

  return (
    <div data-testid="flash">
      <div data-testid="flash-message">{flash ? flash.message : "none"}</div>
      {isPending && <span data-testid="flash-pending">pending</span>}
      <button
        data-testid="flash-set"
        onClick={() =>
          startTransition(async () => {
            await setFlash();
          })
        }
      >
        Set flash
      </button>
    </div>
  );
}
