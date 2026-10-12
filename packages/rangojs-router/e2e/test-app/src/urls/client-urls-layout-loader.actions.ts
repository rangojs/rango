"use server";

import { bumpClientLayoutCartCount } from "./client-urls-layout-loader.store.js";

export async function bumpClientLayoutCart(): Promise<void> {
  bumpClientLayoutCartCount();
}
