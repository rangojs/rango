import { cookies } from "@rangojs/router";

// The intercept-redirect fixture (e2e intercept-redirect.test.ts). The item is
// deleted per test, keyed by the ir-key cookie.
const deleted = new Set<string>();

function key(): string {
  return cookies().get("ir-key")?.value ?? "";
}

/** Whether the item the intercept shows has been deleted. */
export function interceptRedirectItemIsDeleted(): boolean {
  return deleted.has(key());
}

export function deleteInterceptRedirectItem(): void {
  deleted.add(key());
}
