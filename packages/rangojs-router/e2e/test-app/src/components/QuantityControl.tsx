"use client";

import { useOptimistic, startTransition } from "react";
import { updateQuantity, addToCart } from "../actions.jsx";

interface QuantityControlProps {
  productId: string;
  initialQuantity: number;
  testId: string;
}

/**
 * Quantity control with optimistic updates
 */
export function QuantityControl({
  productId,
  initialQuantity,
  testId,
}: QuantityControlProps) {
  const [optimisticQuantity, setOptimisticQuantity] = useOptimistic(
    initialQuantity,
    (_current, newQuantity: number) => newQuantity,
  );

  function handleChange(delta: number) {
    const newQuantity = Math.max(0, optimisticQuantity + delta);
    startTransition(async () => {
      setOptimisticQuantity(newQuantity);
      await updateQuantity(productId, delta);
    });
  }

  function handleAdd() {
    startTransition(async () => {
      setOptimisticQuantity(1);
      await addToCart(productId);
    });
  }

  return (
    <div
      data-testid={testId}
      style={{ display: "flex", alignItems: "center", gap: "8px" }}
    >
      <button
        onClick={() => handleChange(-1)}
        data-testid={`${testId}-decrement`}
        style={{
          width: "32px",
          height: "32px",
          background: "#f44336",
          color: "white",
          border: "none",
          borderRadius: "4px",
          cursor: "pointer",
        }}
      >
        {optimisticQuantity === 1 ? "×" : "-"}
      </button>
      <span
        data-testid="quantity-display"
        style={{ minWidth: "24px", textAlign: "center" }}
      >
        {optimisticQuantity}
      </span>
      <button
        onClick={() => handleChange(1)}
        data-testid={`${testId}-increment`}
        style={{
          width: "32px",
          height: "32px",
          background: "#4CAF50",
          color: "white",
          border: "none",
          borderRadius: "4px",
          cursor: "pointer",
        }}
      >
        +
      </button>
    </div>
  );
}
