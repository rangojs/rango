import { Link } from "@rangojs/router/client";

export function CartPage() {
  return (
    <div data-testid="cart-page">
      <h1 data-testid="cart-title">Shopping Cart</h1>
      <p data-testid="cart-empty">Your cart is empty</p>
      <Link to="/shop" data-testid="continue-shopping">
        Continue Shopping
      </Link>
    </div>
  );
}
