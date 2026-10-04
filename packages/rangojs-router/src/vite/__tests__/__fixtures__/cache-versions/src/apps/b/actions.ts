"use server";

// A file-level action with no bound arguments: nothing this app renders is
// encrypted, so its cache version must not depend on the encryption key.
let pings = 0;

export async function ping(): Promise<void> {
  pings += 1;
}
