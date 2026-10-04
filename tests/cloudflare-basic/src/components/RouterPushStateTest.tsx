"use client";

import { useLocationState, useRouter } from "@rangojs/router/client";
import { ListLocationState } from "../location-states.js";

/**
 * router.push() / router.replace() with a typed entry array. The value must
 * survive back/forward on the entry it was written to.
 */
export function RouterPushStateTest() {
  const router = useRouter();
  const list = useLocationState(ListLocationState);

  return (
    <div data-testid="router-push-state">
      <div data-testid="list-state">
        {list ? `${list.label}:${list.loaded}` : "none"}
      </div>
      <button
        data-testid="list-push-btn"
        onClick={() =>
          router.push("/action-location-state?page=2", {
            state: [ListLocationState({ label: "pushed", loaded: 20 })],
          })
        }
      >
        Push with list state
      </button>
      <button
        data-testid="list-replace-btn"
        onClick={() =>
          router.replace("/action-location-state?page=3", {
            state: [ListLocationState({ label: "replaced", loaded: 30 })],
          })
        }
      >
        Replace with list state
      </button>
    </div>
  );
}
