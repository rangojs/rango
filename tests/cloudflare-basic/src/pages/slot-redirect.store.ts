import { cookies } from "@rangojs/router";

// The slot-redirect fixture (e2e slot-redirect.test.ts). The item is deleted
// per test, keyed by the sr-key cookie.
const deleted = new Set<string>();

function key(): string {
  return cookies().get("sr-key")?.value ?? "";
}

/** Whether the item the slot shows has been deleted. */
export function slotRedirectItemIsDeleted(): boolean {
  return deleted.has(key());
}

export function deleteSlotRedirectItem(): void {
  deleted.add(key());
}
