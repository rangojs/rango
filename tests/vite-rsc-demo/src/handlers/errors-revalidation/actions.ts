"use server";

import { bumpSaves, setStockFailing } from "./state.js";

/**
 * Turns the stock loader's failure on or off. The stock loader's revalidate()
 * skips this action, so flipping the switch does not rerun it: the next Save
 * does.
 */
export async function setStockRefreshFailure(
  failing: boolean,
): Promise<{ failing: boolean }> {
  setStockFailing(failing);
  return { failing };
}

/** Always succeeds. Its revalidation reruns the page's loaders. */
export async function saveNote(
  note: string,
): Promise<{ saved: number; note: string }> {
  return { saved: bumpSaves(), note };
}
