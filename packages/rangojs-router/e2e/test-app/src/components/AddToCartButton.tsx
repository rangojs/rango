"use client";

import { useActionState } from "react";
import { addToCartWithResult } from "../actions.jsx";

interface AddToCartButtonProps {
  productId: string;
  testId: string;
}

/**
 * Add to cart button - imports action directly to preserve metadata
 */
export function AddToCartButton({ productId, testId }: AddToCartButtonProps) {
  const [state, formAction, isPending] = useActionState(
    async () => {
      return await addToCartWithResult(productId);
    },
    null
  );

  return (
    <div>
      <form action={formAction}>
        <button
          type="submit"
          disabled={isPending}
          data-testid={testId}
          style={{
            padding: "8px 16px",
            background: isPending ? "#ccc" : "#4CAF50",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: isPending ? "wait" : "pointer",
          }}
        >
          {isPending ? "Adding..." : "Add to Cart"}
        </button>
      </form>
      {state && (
        <div data-testid={`${testId}-result`} style={{ marginTop: "8px" }}>
          {state.message} (qty: {state.quantity})
        </div>
      )}
    </div>
  );
}
