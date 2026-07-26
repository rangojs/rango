import { cookies, type Middleware } from "@rangojs/router";

const CART_ID_COOKIE_NAME = "shop-cart-id";

function generateCartId(): string {
  return `cart-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Ensure the cart-id cookie exists BEFORE anything streams. Cookie writes are
 * pre-stream authority, exactly like redirects: under streaming documents the
 * shell flushes immediately, so a Set-Cookie issued later from a LOADER
 * (the previous home of this logic, getOrCreateCartId in shop.actions.ts) is
 * silently dropped once headers are gone — every request then minted a fresh
 * cart. It only ever worked on /shop because the blocking handler held the
 * headers back. Middleware runs before the first byte on every lane, so the
 * cookie is guaranteed on documents, navs, and actions alike.
 */
export const ensureCartCookie: Middleware = async (ctx, next) => {
  const jar = cookies();
  if (!jar.get(CART_ID_COOKIE_NAME)?.value) {
    jar.set(CART_ID_COOKIE_NAME, generateCartId(), {
      path: "/",
      httpOnly: false,
      maxAge: 60 * 60 * 24, // 24 hours
    });
  }
  return next();
};
