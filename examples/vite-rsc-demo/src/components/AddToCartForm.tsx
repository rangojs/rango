"use client";

import { startTransition, useActionState } from "react";

type ActionState = {
  success?: boolean;
  message?: string;
  cart?: {
    productId: string;
    previousQuantity: number;
    newQuantity: number;
    totalItems: number;
  };
  error?: string;
} | null;

export function AddToCartForm({
  productId,
  action,
}: {
  productId: string;
  action: (productId: string, quantity: number) => Promise<any>;
}) {
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(
    async (_prevState, formData) => {
      try {
        const result = await action(productId, 1);
        console.log("[AddToCartForm] Action result:", result);
        return result;
      } catch (error) {
        console.error("[AddToCartForm] Action error:", error);
        return { success: false, error: String(error) };
      }
    },
    null // initial state
  );

  return (
    <div>
      <form action={(data) => startTransition(() => formAction(data))}>
        <button
          type="submit"
          disabled={isPending}
          style={{
            background: isPending ? "#ccc" : "#28a745",
            color: "white",
            border: "none",
            padding: "0.75rem 1.5rem",
            borderRadius: "4px",
            fontSize: "1rem",
            cursor: isPending ? "not-allowed" : "pointer",
            marginTop: "1rem",
          }}
        >
          {isPending ? "Adding..." : "Add to Cart (useActionState)"}
        </button>
      </form>

      {state && (
        <div
          style={{
            marginTop: "1rem",
            padding: "1rem",
            background: state.error ? "#f8d7da" : "#d4edda",
            border: `1px solid ${state.error ? "#f5c6cb" : "#c3e6cb"}`,
            borderRadius: "4px",
          }}
        >
          <h4 style={{ margin: "0 0 0.5rem 0" }}>
            {state.error ? "❌ Error" : "✅ Success"}
          </h4>
          {state.error ? (
            <p style={{ margin: 0 }}>{state.error}</p>
          ) : (
            <>
              <p style={{ margin: "0 0 0.5rem 0" }}>
                <strong>{state.message}</strong>
              </p>
              {state.cart && (
                <ul
                  style={{
                    margin: 0,
                    paddingLeft: "1.5rem",
                    fontSize: "0.9rem",
                  }}
                >
                  <li>Product: {state.cart.productId}</li>
                  <li>Previous quantity: {state.cart.previousQuantity}</li>
                  <li>New quantity: {state.cart.newQuantity}</li>
                  <li>Total items in cart: {state.cart.totalItems}</li>
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
