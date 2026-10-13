"use server";

import { bumpClientLayoutCartCount } from "./store.js";

export async function bumpClientLayoutCart(): Promise<void> {
  bumpClientLayoutCartCount();
}

/** An action that changes nothing: it re-runs the layout's loaders without
 *  the cart bump, whose count another case checks exactly. */
export async function rerunClientLayoutRuns(): Promise<void> {}
