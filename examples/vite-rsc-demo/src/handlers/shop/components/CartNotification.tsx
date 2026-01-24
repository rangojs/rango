"use client";

import { useState, useEffect } from "react";
import { useAction } from "@ivogt/rsc-router/client";
import { updateCartQuantity } from "../actions/shop.actions.js";
const getOwnProps = (item: any) => {
  const reflect = Reflect.ownKeys(item);
  const ownProps: Record<string, any> = {};
  reflect.forEach((key) => {
    ownProps[key as string] = (item as any)[key as string];
  });
  return ownProps;
};
export function CartNotification() {
  console.log(
    "updateCartQuantity",
    updateCartQuantity,
    getOwnProps(updateCartQuantity)
  );

  const cartAction = useAction(updateCartQuantity);
  console.log("CartNotification", cartAction.state, { cartAction });

  // Track notification visibility with auto-dismiss
  const [notification, setNotification] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // Set notification when action completes
  useEffect(() => {
    if (cartAction.state === "idle" && cartAction.result !== null) {
      setNotification({ type: "success", message: "Cart updated!" });
    } else if (cartAction.state === "idle" && cartAction.error !== null) {
      setNotification({ type: "error", message: "Failed to update cart" });
    }
  }, [cartAction.state, cartAction.result, cartAction.error]);

  // Auto-dismiss notification after 5 seconds
  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => {
        setNotification(null);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  const isLoading = cartAction.state !== "idle";

  // Loading notification
  if (isLoading) {
    return (
      <div
        style={{
          position: "fixed",
          top: "1rem",
          right: "1rem",
          background: cartAction.state === "loading" ? "#3b82f6" : "#10b981",
          color: "white",
          padding: "0.75rem 1.25rem",
          borderRadius: "8px",
          boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
          zIndex: 1001,
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          animation: "slideIn 0.2s ease-out",
        }}
      >
        {cartAction.state === "loading" && (
          <>
            <span
              style={{
                width: "16px",
                height: "16px",
                border: "2px solid white",
                borderTopColor: "transparent",
                borderRadius: "50%",
                animation: "spin 0.8s linear infinite",
              }}
            />
            Updating cart...
          </>
        )}
        {cartAction.state === "streaming" && (
          <>
            <span>⏳</span>
            Processing...
          </>
        )}
      </div>
    );
  }

  // Result notification (auto-dismisses after 5 seconds)
  if (notification) {
    return (
      <div
        style={{
          position: "fixed",
          top: "1rem",
          right: "1rem",
          background: notification.type === "success" ? "#10b981" : "#ef4444",
          color: "white",
          padding: "0.75rem 1.25rem",
          borderRadius: "8px",
          boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
          zIndex: 1001,
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
        }}
      >
        <span>{notification.type === "success" ? "✓" : "✗"}</span>
        {notification.message}
      </div>
    );
  }

  return null;
}
