"use server";

import { getRequestContext } from "@rangojs/router";
import {
  ActionFlash,
  ConcurrentSlotA,
  ConcurrentSlotB,
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
