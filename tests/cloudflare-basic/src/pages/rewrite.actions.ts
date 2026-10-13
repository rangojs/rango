"use server";

import { cookies } from "@rangojs/router";
import { bumpRwItemSaves } from "./rewrite-saves.js";

/** The shop page's save button (e2e/rewrite.test.ts): JS action and no-JS form. */
export async function rwSaveCart(): Promise<void> {}

/** The rewritten item page's save button: counts a save for the test's key. */
export async function rwSaveItem(): Promise<void> {
  bumpRwItemSaves(cookies().get("rw-key")?.value ?? "none");
}

/** The item page's failing save: its error boundary is the target's. */
export async function rwFailItem(): Promise<void> {
  throw new Error("rw item save failed");
}
