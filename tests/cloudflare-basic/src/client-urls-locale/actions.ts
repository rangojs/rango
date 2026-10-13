"use server";

/** Echoes the item it was called with (urls.tsx). */
export async function echoClientLocaleItem(itemId: string): Promise<string> {
  return `echo:${itemId}`;
}
