"use server";

/**
 * /hook-fields/:id's save: answers after 300 ms. The page it re-renders holds
 * on the client, so React holds the action's commit.
 */
export async function hookFieldsSave(): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return "saved";
}
