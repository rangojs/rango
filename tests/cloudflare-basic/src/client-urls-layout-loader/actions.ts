"use server";

import { bumpClientLayoutCartCount } from "./store.js";

export async function bumpClientLayoutCart(): Promise<void> {
  bumpClientLayoutCartCount();
}
