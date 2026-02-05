import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * Tests for connection warmup (HEAD /?_rsc_warmup -> 204).
 *
 * Warmup is enabled by default. The server returns 204 No Content
 * for HEAD requests with ?_rsc_warmup before any middleware or routing.
 */

test.describe("connection-warmup", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("HEAD /?_rsc_warmup returns 204", async ({ page }) => {
    const response = await page.request.head(f.url("/?_rsc_warmup"));

    expect(response.status()).toBe(204);
    expect(await response.text()).toBe("");
  });

  test("warmup does not interfere with normal GET /", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Warmup first
    const warmup = await page.request.head(f.url("/?_rsc_warmup"));
    expect(warmup.status()).toBe(204);

    // Normal page load still works
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Verify page rendered (test-app index has content)
    expect(page.url()).toContain("/");
  });

  test("warmup bypasses middleware", async ({ page }) => {
    // The test-app has globalMiddleware that sets X-Global-Middleware header.
    // Warmup should return before middleware runs, so the header should be absent.
    const response = await page.request.head(f.url("/?_rsc_warmup"));

    expect(response.status()).toBe(204);
    expect(response.headers()["x-global-middleware"]).toBeUndefined();
  });

  test("GET /?_rsc_warmup is treated as normal request", async ({ page }) => {
    using _ = expectNoPageError(page);

    // GET with ?_rsc_warmup should NOT trigger the warmup shortcut
    // (only HEAD method triggers it)
    await page.goto(f.url("/?_rsc_warmup"));
    await waitForHydration(page);

    // Should render the normal index page
    expect(page.url()).toContain("_rsc_warmup");
  });
});
