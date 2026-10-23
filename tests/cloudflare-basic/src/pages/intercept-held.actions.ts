"use server";

import { redirect } from "@rangojs/router";
import { bumpRedirectWrites } from "./intercept-held.defs.js";

// intercept-held.test.ts: a server action called from an open modal.
export async function interceptHeldAction(): Promise<void> {}

// A server action that redirects to a route intercepted from the page that
// called it (rango-t126).
export async function interceptHeldRedirectAction(): Promise<void> {
  bumpRedirectWrites();
  throw redirect("/intercept-held/handler/1");
}
