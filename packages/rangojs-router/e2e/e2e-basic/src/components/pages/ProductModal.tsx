import { Link } from "@rangojs/router/client";

interface ProductModalProps {
  params: { productId: string };
}

export function ProductModal({ params }: ProductModalProps) {
  return (
    <div
      data-testid="product-modal"
      style={{
        position: "fixed",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        background: "white",
        padding: "20px",
        border: "2px solid #333",
        zIndex: 1000,
      }}
    >
      <span data-testid="modal-indicator">Modal</span>
      <h2 data-testid="modal-product-name">{params.productId}</h2>
      <p>Quick view of {params.productId}</p>
      <Link to={`/shop/product/${params.productId}`} data-testid="view-full">
        View Full Details
      </Link>
    </div>
  );
}
