import { cookies } from "@rangojs/router";

// Cart state keyed by cart ID (cookie-based isolation for parallel tests).
// Lives outside actions.tsx so server-side loaders can read it without
// dynamic-importing a "use server" module — that pattern races with the
// RSC "use server" transform under concurrent SSR load and produces
// TDZ errors ("Cannot access 'carts' before initialization").
const carts: Map<string, Map<string, number>> = new Map();

function getCartId(): string {
  const jar = cookies();
  let cartId = jar.get("cart-id")?.value;
  if (!cartId) {
    cartId = Math.random().toString(36).slice(2);
    jar.set("cart-id", cartId, { path: "/" });
  }
  return cartId;
}

export function getCurrentCart(): Map<string, number> {
  const cartId = getCartId();
  let cart = carts.get(cartId);
  if (!cart) {
    cart = new Map();
    carts.set(cartId, cart);
  }
  return cart;
}

export function getCartQuantitySync(productId: string): number {
  return getCurrentCart().get(productId) || 0;
}

export function setCartQuantity(productId: string, quantity: number): void {
  const cart = getCurrentCart();
  if (quantity === 0) {
    cart.delete(productId);
  } else {
    cart.set(productId, quantity);
  }
}

export function resetCurrentCart(): void {
  const cartId = getCartId();
  carts.delete(cartId);
}
