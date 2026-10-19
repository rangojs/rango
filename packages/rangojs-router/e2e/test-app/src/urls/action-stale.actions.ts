"use server";

import { actionStaleState, wait } from "./action-stale.store.js";

/**
 * Adds an item to the cart. "first" writes as the request arrives and answers
 * `ms` later; "last" writes after `ms`, just before it answers.
 */
export async function addToActionStaleCart(
  writeAt: "first" | "last",
  ms: number,
): Promise<void> {
  if (writeAt === "first") actionStaleState().cart += 1;
  await wait(ms);
  if (writeAt === "last") actionStaleState().cart += 1;
}
