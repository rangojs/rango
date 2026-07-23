"use server";

import { getRequestContext, redirect } from "@rangojs/router";
import {
  ActionFlash,
  ConcurrentSlotA,
  ConcurrentSlotB,
  NonSerializableState,
} from "../location-states.js";

export async function setLocationStateAction(): Promise<string> {
  const ctx = getRequestContext();
  ctx.setLocationState([ActionFlash({ message: "saved-from-action" })]);
  return "ok";
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Non-redirect action that sets a distinct concurrent slot after a delay.
 * Dispatched concurrently so the first-initiated action can settle last,
 * forcing the consolidation-needed / concurrent-skip terminals that drop
 * action-set location state pre-fix.
 */
export async function setConcurrentSlot(
  slot: "A" | "B",
  value: string,
  delayMs: number,
): Promise<void> {
  await delay(delayMs);
  const def = slot === "A" ? ConcurrentSlotA : ConcurrentSlotB;
  getRequestContext().setLocationState([def({ value })]);
}

/**
 * Action that throws a redirect carrying location state React Flight cannot
 * serialize (a function). The redirect is valid, so the handler returns a 200
 * Flight redirect payload -- but createRedirectFlightResponse's
 * renderToReadableStream fails serializing the function under workerd during
 * real async serialization. The fix wires that failure to onError("rendering");
 * without it the consumer's onError never sees the broken stream.
 *
 * The function is stored past the typed `bad: unknown` slot via `as any`; the
 * compile-time ValidateLocationState guard rejects functions/symbols by design,
 * so the cast is the point -- it reproduces a consumer who casts past the guard
 * and leaks a non-serializable value at runtime.
 */
export async function redirectWithNonSerializableState(): Promise<void> {
  throw redirect("/action-location-state", {
    state: NonSerializableState({
      text: "redirect with non-serializable state",
      bad: () => "not serializable",
    } as any),
  });
}
