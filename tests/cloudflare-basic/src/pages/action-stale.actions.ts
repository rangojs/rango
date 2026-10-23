"use server";

import { keepClientCache } from "@rangojs/router";
import { actionStaleState, wait } from "./action-stale.store.js";

/**
 * Adds an item to the cart and returns the count. "first" writes as the
 * request arrives and answers `ms` later; "last" writes after `ms`, just
 * before it answers.
 */
export async function addToActionStaleCart(
  writeAt: "first" | "last",
  ms: number,
): Promise<number> {
  if (writeAt === "first") actionStaleState().cart += 1;
  await wait(ms);
  if (writeAt === "last") actionStaleState().cart += 1;
  return actionStaleState().cart;
}

/**
 * Adds an item to the cart as the request arrives, then throws `ms` later;
 * `keep` calls keepClientCache() first.
 */
export async function failActionStaleCart(
  keep: boolean,
  ms: number,
): Promise<never> {
  if (keep) keepClientCache();
  actionStaleState().cart += 1;
  await wait(ms);
  throw new Error("as-out-of-stock");
}
