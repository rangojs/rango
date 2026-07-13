"use server";

import { createElement, type ReactNode } from "react";

/**
 * Streaming action demo - returns a Promise that resolves on the client
 *
 * This demonstrates RSC's ability to stream Promises to the client,
 * where they can be awaited using Suspense boundaries.
 */
export interface StreamingCartResult {
  promise: Promise<ReactNode>;
}

export async function addToCartSlowly(
  _previous: StreamingCartResult | null,
  formData: FormData,
): Promise<StreamingCartResult> {
  const productId = String(formData.get("productId"));
  const quantity = Number(formData.get("quantity") ?? 1);
  console.log(`[Action] addToCartSlowly: Starting for ${productId}...`);

  // Keep the action pending first, then return a nested promise. Returning the
  // promise itself from an async action would assimilate it and remove the
  // Suspense streaming phase entirely.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const resultPromise = new Promise<ReactNode>((resolve) => {
    setTimeout(() => {
      console.log(`[Action] addToCartSlowly: Stream completed`);
      resolve(
        createElement(
          "span",
          null,
          `Completed! Added ${quantity} ${productId}`,
        ),
      );
    }, 6000);
  });

  console.log(
    `[Action] addToCartSlowly: Returning Promise (will stream to client)`,
  );

  return { promise: resultPromise };
}

/**
 * Alternative: Return promise that can reject
 */
export async function addToCartWithValidation(
  productId: string,
  quantity: number = 1,
) {
  console.log(`[Action] addToCartWithValidation: ${productId} x${quantity}`);

  // Return Promise that might reject
  // oxlint-disable-next-line no-async-promise-executor -- intentional: stream result after delay
  return new Promise(async (resolve, reject) => {
    await new Promise((wait) => setTimeout(wait, 2000));

    // Simulate validation
    if (quantity > 5) {
      console.log(`[Action] Validation failed: quantity too high`);
      reject(new Error("Cannot add more than 5 items at once"));
      return;
    }

    console.log(`[Action] Validation passed`);
    resolve({
      success: true,
      message: `Added ${quantity} ${productId}`,
      quantity,
    });
  });
}
