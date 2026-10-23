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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Adds an item to the cart, then throws after a delay (rango-t125). */
export async function failLateActionBoundaryCart(): Promise<never> {
  await sleep(1000);
  bumpActionBoundaryCart();
  throw new Error("ab-late-out-of-stock");
}

/** A slow action that succeeds; it outlasts failLateActionBoundaryCart. */
export async function slowActionBoundaryAction(): Promise<string> {
  await sleep(3500);
  return "y-done";
}
