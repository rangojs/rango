import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, testId } from "./helper";

test.describe("response handler", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("direct visit to response route returns JSON", async ({ page }) => {
    const response = await page.goto(f.url("/api/health"));
    expect(response!.status()).toBe(200);
    expect(response!.headers()["content-type"]).toContain("application/json");

    const body = await response!.json();
    expect(body).toEqual({ status: "ok" });
  });

  test("client-side navigation to response route triggers hard navigation", async ({ page }) => {
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Click the API health link (client-side navigation)
    await testId(page, "nav-api-health").click();

    // Should hard-navigate to /api/health and show JSON
    await page.waitForURL(/\/api\/health/);
    const text = await page.innerText("body");
    expect(JSON.parse(text)).toEqual({ status: "ok" });
  });
});
