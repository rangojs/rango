"use client";

import { deleteInterceptRedirectItem } from "./intercept-redirect.actions.js";

/** Deletes the item: the open intercept's handler redirects on the action. */
export function InterceptRedirectDelete() {
  return (
    <button
      data-testid="ir-delete"
      onClick={() => void deleteInterceptRedirectItem()}
    >
      Delete
    </button>
  );
}
