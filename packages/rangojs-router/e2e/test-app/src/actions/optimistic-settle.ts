"use server";

/** /opt-settle/*: an action that takes a while and changes nothing. */
export async function optimisticSettleSave(): Promise<number> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return Date.now();
}
