"use server";

import {
  bumpStaleDefaultsCart,
  bumpStaleDefaultsKeyed,
} from "./stale-defaults.store.js";

/** Adds an item to the cart and returns the count. */
export async function addToStaleDefaultsCart(): Promise<number> {
  return bumpStaleDefaultsCart();
}

/** Adds to the cart and to the count keyed by `k`; returns the latter. */
export async function addToStaleDefaultsKeyed(k: string): Promise<number> {
  bumpStaleDefaultsCart();
  return bumpStaleDefaultsKeyed(k);
}
