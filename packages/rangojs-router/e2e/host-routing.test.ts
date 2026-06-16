import { test, expect } from "@playwright/test";

// Proves a node/vercel host-router app renders through rango's generated host RSC
// entry (hostRouter.match()), in BOTH dev and production. The fixture lives at
// e2e/test-app/.host-fixture and is served by the host webServer entries in
// playwright.config.ts. Routing is by hostname; *.localhost resolves to loopback,
// and the fixture sets allowedHosts: true so an unmatched host still reaches the
// host router (which 404s) instead of vite's host check.
const HOST_DEV_PORT = 5198;
const HOST_PREVIEW_PORT = 5199;

function hostRoutingTests(port: number) {
  test("dispatches each matched host to its sub-app", async ({ page }) => {
    const a = await page.goto(`http://a.localhost:${port}/`);
    expect(a?.status()).toBe(200);
    await expect(page.getByTestId("app")).toHaveText("App A home");

    const b = await page.goto(`http://b.localhost:${port}/`);
    expect(b?.status()).toBe(200);
    await expect(page.getByTestId("app")).toHaveText("App B home");
  });

  test("returns 404 for an unmatched host (generated entry catches NoRouteMatchError)", async ({
    page,
  }) => {
    const res = await page.goto(`http://c.localhost:${port}/`);
    expect(res?.status()).toBe(404);
  });
}

test.describe("host router on node preset (dev)", () =>
  hostRoutingTests(HOST_DEV_PORT));

test.describe("host router on node preset (production)", () =>
  hostRoutingTests(HOST_PREVIEW_PORT));
