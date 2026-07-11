"use server";

import { cookies } from "@rangojs/router";

/**
 * The storefront basket shape (issue #713 middleware-live pinning): the action
 * rotates the basket/session cookie; the FOLLOWING document GET is a shell HIT
 * whose middleware must still see the cookie and reflect it per request —
 * session continuity through action POST -> GET(HIT).
 *
 * Actions run BEFORE the re-render enters cached territory, so this cookie
 * write is on the live lane (the guard never applies to actions).
 */
export async function addToBasket(): Promise<number> {
  const jar = cookies();
  const current = Number(jar.get("basket_count")?.value ?? "0");
  const next = current + 1;
  jar.set("basket_count", String(next), { path: "/" });
  return next;
}
