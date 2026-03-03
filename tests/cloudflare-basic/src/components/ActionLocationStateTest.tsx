"use client";

import { useTransition } from "react";
import { useLocationState } from "@rangojs/router/client";
import { ActionFlash } from "../location-states.js";
import { setLocationStateAction } from "../actions/action-location-state.js";

export function ActionLocationStateTest() {
  const flash = useLocationState(ActionFlash);
  const [isPending, startTransition] = useTransition();

  return (
    <div data-testid="action-location-state-test">
      <div data-testid="flash-message">{flash?.message ?? "none"}</div>
      {isPending && <div data-testid="pending">pending</div>}

      <button
        data-testid="set-location-state-btn"
        onClick={() =>
          startTransition(async () => {
            await setLocationStateAction();
          })
        }
      >
        Set Location State
      </button>
    </div>
  );
}
