"use client";

import { useLoader } from "rsc-router/client";
import { CartLoader } from "../handlers/shop/loaders/cart.js";
import { UserLoader } from "../handlers/shop/loaders/user.js";

/**
 * CartBadge - Client component that displays cart item count
 *
 * This demonstrates how client components can access loader data
 * using the useLoader() hook. The loader runs on the server,
 * and its data is passed to the client via RSC payload.
 */
export function CartBadge() {
  const { data: cart } = useLoader(CartLoader);
  console.log("CartBadge", cart);

  return (
    <span className="cart-badge" title={`Total: $${cart.total.toFixed(2)}`}>
      🛒 ({cart.itemCount})
    </span>
  );
}

/**
 * UserGreeting - Client component that displays user name
 *
 * Demonstrates useLoader() with UserLoader to show the current user's name.
 * The UserLoader runs on the server and its data is available to this
 * client component via the RSC payload.
 */
export function UserGreeting() {
  const { data: user } = useLoader(UserLoader);
  console.log("UserGreeting", user);

  return (
    <span className="user-greeting" title={user.email}>
      👤 {user.name}
    </span>
  );
}
