"use server";

let bumps = 0;

/** Any action: the page's loaders re-run unless their revalidate() says no. */
export async function scBumpAction(): Promise<number> {
  await new Promise((resolve) => setTimeout(resolve, 30));
  return ++bumps;
}
