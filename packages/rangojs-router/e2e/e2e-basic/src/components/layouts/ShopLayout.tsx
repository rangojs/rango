import { Outlet, Link } from "@rangojs/router/client";

export function ShopLayout() {
  return (
    <div data-testid="shop-layout">
      <h2>Shop Section</h2>
      <nav data-testid="shop-nav">
        <Link to="/shop" data-testid="shop-index-link">
          Products
        </Link>
        {" | "}
        <Link to="/shop/cart" data-testid="shop-cart-link">
          Cart
        </Link>
      </nav>
      <div data-testid="shop-content">
        <Outlet />
      </div>
      <Outlet name="@modal" />
    </div>
  );
}
