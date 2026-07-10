import { expect, test } from "@playwright/test";
import {
  devSpec,
  prodSpec,
  expectNoPageError,
  testId,
  type Fixture,
} from "./helper";

/**
 * Host-router e2e for the node/vercel preset (the committed dev+prod coverage
 * promised when the polymorphic host entry shipped): rango's generated entry
 * imports the exported HostRouter INSTANCE and serves hostRouter.match(), so
 * routing is by Host header — a.localhost -> app A, b.localhost -> app B, and
 * an unmatched host exercises the generated entry's NoRouteMatchError -> 404
 * catch (parity with the documented Cloudflare worker catch). The deploy-shape
 * bundling of the same output is covered headlessly by scripts/smoke.mjs.
 */
function runSpec(f: Fixture): void {
  // Chromium and node resolve *.localhost to 127.0.0.1, so swapping the host
  // in the fixture URL drives the same server under a different Host header.
  const hostUrl = (host: string, pathname: string) =>
    f.url(pathname).replace("localhost", host);

  test("a.localhost serves app A", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(hostUrl("a.localhost", "/"));
    await expect(testId(page, "app")).toHaveText("App A home");
  });

  test("b.localhost serves app B", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(hostUrl("b.localhost", "/"));
    await expect(testId(page, "app")).toHaveText("App B home");
  });

  test("host isolation: app A's document never carries app B content", async ({
    page,
  }) => {
    const res = await page.request.get(hostUrl("a.localhost", "/"), {
      headers: { accept: "text/html" },
    });
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain("App A home");
    expect(html).not.toContain("App B home");
  });

  test("unmatched host returns the generated entry's 404", async ({ page }) => {
    // No catch-all host is registered, so hostRouter.match() throws
    // NoRouteMatchError and the generated entry must answer 404, not 500.
    const res = await page.request.get(hostUrl("c.localhost", "/"), {
      headers: { accept: "text/html" },
    });
    expect(res.status()).toBe(404);
  });
}

devSpec("vercel host router", runSpec);
prodSpec("vercel host router", runSpec);
