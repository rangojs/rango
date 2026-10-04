import { test as setup, expect } from "@playwright/test";

// Warm the dev worker's module graph on the ppr fixture route before the
// edge-only suite polls for shell HITs: the first dev capture races cold vite
// transforms, and warming here keeps the MISS -> HIT poll inside its budget.
setup("warmup edge-only dev server", async ({ page, baseURL }) => {
  setup.setTimeout(60_000);

  await expect(async () => {
    const first = await page.goto(new URL("/ppr-shell", baseURL).href);
    expect(first?.ok()).toBe(true);

    const second = await page.reload();
    expect(second?.ok()).toBe(true);
    await page.waitForFunction(
      () => document.documentElement.hasAttribute("data-hydrated"),
      { timeout: 10_000 },
    );
  }).toPass({ timeout: 45_000, intervals: [2_000, 3_000, 5_000] });
});
