import { expect, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Wait for hydration without waiting for DOMContentLoaded. A pending PPR hole
 * keeps the document stream open, so the normal helper cannot reach its
 * hydration check until the condition this kind of test needs to observe has
 * already disappeared.
 */
export async function waitForShellHydration(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.documentElement.hasAttribute("data-hydrated"),
    { timeout: 20_000 },
  );
}

/** Request `url` as a document until its PPR shell is captured and HITs. */
export async function warmShellRequestToHit(
  request: APIRequestContext,
  url: string,
): Promise<void> {
  await expect(async () => {
    const res = await request.get(url, { headers: { Accept: "text/html" } });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-rango-shell"]).toBe("HIT");
  }).toPass({ timeout: 20_000 });
}
