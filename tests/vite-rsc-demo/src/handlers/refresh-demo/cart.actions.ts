"use server";

import { cookies } from "@rangojs/router";

// Cart write path for the products-table demo. The mutation is a real server
// action (addToCart); the cart re-read is driven by the client refresh
// primitive (useRefreshLoaders), not by this action's return value.
//
// Carts are keyed by a cookie so each browser context (and each e2e run) gets an
// isolated cart — the count assertions can use relative increments without
// cross-test interference. CartLoader reads this state via getCartEntries().

const CART_COOKIE = "refresh-demo-cart-id";

// In-memory carts keyed by cart id: cartId -> (productId -> quantity).
const carts = new Map<string, Map<string, number>>();

function currentCartId(): string {
  const jar = cookies();
  let id = jar.get(CART_COOKIE)?.value;
  if (!id) {
    id = `rd-cart-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    jar.set(CART_COOKIE, id, { path: "/", httpOnly: false, maxAge: 60 * 60 });
  }
  return id;
}

function cartFor(id: string): Map<string, number> {
  let c = carts.get(id);
  if (!c) {
    c = new Map();
    carts.set(id, c);
  }
  return c;
}

/** Mutation: add one unit of a product to the current cart. Returns nothing —
 * the UI re-renders by refreshing CartLoader, not from this value. */
export async function addToCart(productId: string): Promise<void> {
  const cart = cartFor(currentCartId());
  cart.set(productId, (cart.get(productId) ?? 0) + 1);
}

/** Read helper used by CartLoader (server-side function call). */
export async function getCartEntries(): Promise<[string, number][]> {
  return [...cartFor(currentCartId()).entries()];
}
