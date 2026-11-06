"use server";

import { deleteInterceptRedirectItem as markDeleted } from "./intercept-redirect.store.js";

/** Deletes the item the open intercept shows. */
export async function deleteInterceptRedirectItem(): Promise<void> {
  markDeleted();
}
