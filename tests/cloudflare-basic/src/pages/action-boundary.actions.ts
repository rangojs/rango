"use server";

import { keepClientCache } from "@rangojs/router";
import {
  bumpActionBoundaryCart,
  bumpActionBoundaryNote,
} from "./action-boundary.store.js";

/** Adds an item to the cart and returns the count. */
export async function addToActionBoundaryCart(): Promise<number> {
  return bumpActionBoundaryCart();
}

/** Adds an item to the cart, then throws. */
export async function failActionBoundaryCart(): Promise<never> {
  bumpActionBoundaryCart();
  throw new Error("ab-out-of-stock");
}

/** A rejected form: writes nothing, keeps the client cache, throws. */
export async function rejectActionBoundaryForm(): Promise<never> {
  keepClientCache();
  throw new Error("ab-invalid");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Adds an item to the cart, then throws after a delay. */
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

/** Adds an item to the cart, then throws after 4.5 s: it outlasts slowActionBoundaryAction. */
export async function failSlowActionBoundaryCart(): Promise<never> {
  await sleep(4500);
  bumpActionBoundaryCart();
  throw new Error("ab-slow-out-of-stock");
}

/** Writes a note after 3.5 s; only it re-runs the layout's note loader. */
export async function slowActionBoundaryNote(): Promise<number> {
  await sleep(3500);
  return bumpActionBoundaryNote();
}
