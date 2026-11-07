"use server";

import { deleteSlotRedirectItem as markDeleted } from "./slot-redirect.store.js";

/** Deletes the item the slot shows. */
export async function deleteSlotRedirectItem(): Promise<void> {
  markDeleted();
}
