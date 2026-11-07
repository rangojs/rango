"use client";

import { useRouter } from "@rangojs/router/client";
import { armSlotRedirect } from "./slot-redirect.actions.js";

/** Calls the action that arms the redirects; its revalidation re-renders the page. */
export function SlotRedirectArm() {
  return (
    <button data-testid="sr-arm" onClick={() => void armSlotRedirect()}>
      Arm
    </button>
  );
}

/** Calls router.refresh(). */
export function SlotRedirectRefresh() {
  const router = useRouter();
  return (
    <button data-testid="sr-refresh" onClick={() => void router.refresh()}>
      Refresh
    </button>
  );
}
