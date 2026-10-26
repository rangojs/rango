"use server";

import { bumpInterceptBoundaryCart } from "./intercept-boundary.store.js";

/** Adds an item to the cart and returns the count. */
export async function addToInterceptBoundaryCart(): Promise<number> {
  return bumpInterceptBoundaryCart();
}

/** Adds an item to the cart, then throws. */
export async function failInterceptBoundaryItem(): Promise<never> {
  bumpInterceptBoundaryCart();
  throw new Error("ib-out-of-stock");
}
