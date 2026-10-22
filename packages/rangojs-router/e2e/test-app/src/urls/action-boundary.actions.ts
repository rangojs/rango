"use server";

import { bumpActionBoundaryCart } from "./action-boundary.store.js";

/** Adds an item to the cart and returns the count. */
export async function addToActionBoundaryCart(): Promise<number> {
  return bumpActionBoundaryCart();
}

/** Adds an item to the cart, then throws. */
export async function failActionBoundaryCart(): Promise<never> {
  bumpActionBoundaryCart();
  throw new Error("ab-out-of-stock");
}
