"use server";

import { ReactNode } from "react";

// Simulated delay helper
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Simple cart state (in-memory for testing)
let cartItems: Map<string, number> = new Map();

/**
 * Add item to cart - fire and forget pattern
 */
export async function addToCart(productId: string): Promise<void> {
  await delay(100);
  const current = cartItems.get(productId) || 0;
  cartItems.set(productId, current + 1);
}

/**
 * Add item to cart with result - returns confirmation
 */
export async function addToCartWithResult(
  productId: string
): Promise<{ success: boolean; quantity: number; message: string }> {
  await delay(100);
  const current = cartItems.get(productId) || 0;
  const newQuantity = current + 1;
  cartItems.set(productId, newQuantity);
  return {
    success: true,
    quantity: newQuantity,
    message: `Added ${productId} to cart`,
  };
}

/**
 * Update cart quantity
 */
export async function updateQuantity(
  productId: string,
  delta: number
): Promise<{ quantity: number }> {
  await delay(50);
  const current = cartItems.get(productId) || 0;
  const newQuantity = Math.max(0, current + delta);
  if (newQuantity === 0) {
    cartItems.delete(productId);
  } else {
    cartItems.set(productId, newQuantity);
  }
  return { quantity: newQuantity };
}

/**
 * Get cart quantity for a product
 */
export async function getCartQuantity(productId: string): Promise<number> {
  return cartItems.get(productId) || 0;
}

/**
 * Streaming action - takes 3 seconds to complete
 */
export async function streamingAction(
  productId: string
): Promise<{ success: boolean; timestamp: string }> {
  await delay(3000);
  return {
    success: true,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Reset cart - for test cleanup
 */
export async function resetCart(): Promise<void> {
  cartItems = new Map();
}

/**
 * Simple action that triggers revalidation
 * Used to test that loaders registered with loader() are revalidated
 */
export async function triggerRevalidation(): Promise<{ triggered: boolean; timestamp: string }> {
  await delay(100);
  return {
    triggered: true,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Simple form action for testing progressive enhancement (no-JS)
 * Returns the submitted name to verify the form was processed
 */
let lastSubmittedName: string | null = null;

export async function submitNameAction(formData: FormData): Promise<void> {
  await delay(100);
  const name = formData.get("name") as string;
  lastSubmittedName = name;
}

export async function getLastSubmittedName(): Promise<string | null> {
  return lastSubmittedName;
}

export async function resetLastSubmittedName(): Promise<void> {
  lastSubmittedName = null;
}

/**
 * Streaming action with React node result
 * Total time: 1s initial + 2s streaming = 3s (matches test expectations)
 */
export const StreamingAction = async (_data: FormData) => {
  await new Promise((resolve) => setTimeout(resolve, 1000)); // 1s initial delay
  return {
    promise: new Promise<ReactNode>((resolve) => {
      setTimeout(() => {
        resolve(
          <>
            <div
              style={{
                background: "#d4edda",
                padding: "1rem",
                borderRadius: "4px",
              }}
            >
              <h4 style={{ margin: "0 0 0.5rem 0" }}>Completed!</h4>
            </div>
          </>
        );
      }, 2000); // 2s streaming delay
    }),
  };
};
