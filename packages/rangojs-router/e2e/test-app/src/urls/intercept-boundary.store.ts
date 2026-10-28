import { cookies } from "@rangojs/router";

// The intercept-boundary fixture (e2e intercept-boundary.test.ts). The cart
// is per test, keyed by the ib-key cookie.
const carts = new Map<string, number>();

function key(): string {
  return cookies().get("ib-key")?.value ?? "";
}

export function readInterceptBoundaryCart(): number {
  return carts.get(key()) ?? 0;
}

export function bumpInterceptBoundaryCart(): number {
  const cart = readInterceptBoundaryCart() + 1;
  carts.set(key(), cart);
  return cart;
}
