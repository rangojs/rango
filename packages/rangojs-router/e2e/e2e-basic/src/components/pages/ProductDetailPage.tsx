import { Link } from "@rangojs/router/client";

interface ProductDetailProps {
  params: { productId: string };
}

export function ProductDetailPage({ params }: ProductDetailProps) {
  return (
    <div data-testid="product-detail-page">
      <h1 data-testid="product-name">{params.productId}</h1>
      <p data-testid="product-description">
        Details for {params.productId}
      </p>
      <Link to="/shop" data-testid="back-to-shop">
        ← Back to Products
      </Link>
    </div>
  );
}
