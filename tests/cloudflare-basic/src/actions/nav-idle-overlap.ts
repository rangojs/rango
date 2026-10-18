"use server";

/**
 * /nav-idle-overlap: an action that changes nothing and answers after 300 ms,
 * so it settles while a filter navigation's page is still held.
 */
export async function navIdleOverlapAction(): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return "done";
}
