import { Link } from "@rangojs/router/client";

export function ShopIndexPage() {
  return (
    <div data-testid="shop-index-page">
      <h1 data-testid="shop-title">Products</h1>
      <ul data-testid="product-list">
        <li>
          <Link to="/shop/product/widget" data-testid="product-link-1">
            Widget - $10
          </Link>
        </li>
        <li>
          <Link to="/shop/product/gadget" data-testid="product-link-2">
            Gadget - $25
          </Link>
        </li>
      </ul>
    </div>
  );
}
