"use client";

import { useLoader } from "@ivogt/rsc-router/client";
import { CartLoader } from "../handlers/shop/loaders/cart.js";
import { UserLoader } from "../handlers/shop/loaders/user.js";
import { clearCart } from "../handlers/shop/actions/shop.actions.js";

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
      {cart.itemCount > 0 && (
        <button
          data-testid="clear-cart"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            clearCart();
          }}
          style={{
            marginLeft: "0.5rem",
            fontSize: "0.7rem",
            padding: "0.1rem 0.3rem",
            cursor: "pointer",
            background: "#ff6b6b",
            color: "white",
            border: "none",
            borderRadius: "3px",
          }}
          title="Clear cart (for testing)"
        >
          X
        </button>
      )}
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
