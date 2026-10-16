"use server";

/**
 * /action-latest*: an add-to-cart action whose delay each call sets, so a
 * later call can return before an earlier one. Returns the name it was given.
 */
export async function addToCartLatest(
  name: string,
  delay: number,
): Promise<{ name: string }> {
  await new Promise((resolve) => setTimeout(resolve, delay));
  return { name };
}
