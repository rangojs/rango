"use server";

/**
 * Streaming action demo - returns a Promise that resolves on the client
 *
 * This demonstrates RSC's ability to stream Promises to the client,
 * where they can be awaited using Suspense boundaries.
 */
export async function addToCartSlowly(productId: string, quantity: number = 1) {
  console.log(`[Action] addToCartSlowly: Starting for ${productId}...`);

  // Return a Promise immediately (don't await!)
  // This Promise will be serialized and sent to the client
  // oxlint-disable-next-line no-async-promise-executor -- intentional: stream result after delay
  const resultPromise = new Promise(async (resolve) => {
    // Simulate slow operation (3 seconds)
    await new Promise((wait) => setTimeout(wait, 1000));

    console.log(`[Action] addToCartSlowly: Completed after 3s`);

    resolve({
      success: true,
      message: `Successfully added ${quantity} ${productId} after 1 seconds!`,
      timestamp: new Date().toISOString(),
      cart: {
        productId,
        quantity,
        totalItems: quantity, // Simplified
      },
    });
  });

  console.log(
    `[Action] addToCartSlowly: Returning Promise (will stream to client)`,
  );

  // Return the Promise - RSC will serialize it and stream to client
  return resultPromise;
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
