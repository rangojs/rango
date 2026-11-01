"use server";

import { bumpClientLayoutCartCount } from "./client-urls-layout-loader.store.js";

export async function bumpClientLayoutCart(): Promise<void> {
  bumpClientLayoutCartCount();
}

/** An action that changes nothing: it re-runs the layout's loaders without
 *  the cart bump, whose count another case checks exactly. */
export async function rerunClientLayoutRuns(): Promise<void> {}

/** Lands after the navigation sent just before it has committed. */
export async function loadClientLayoutMountOptions(): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 500));
  return "options";
}
