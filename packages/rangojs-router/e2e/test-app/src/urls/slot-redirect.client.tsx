"use client";

import { deleteSlotRedirectItem } from "./slot-redirect.actions.js";

/** Deletes the item: the slot's handler redirects on the action. */
export function SlotRedirectDelete() {
  return (
    <button
      data-testid="sr-delete"
      onClick={() => void deleteSlotRedirectItem()}
    >
      Delete
    </button>
  );
}
