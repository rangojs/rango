import { test, expect } from "@playwright/test";
import { waitForHydration } from "./helper";

// Proves a node/vercel host-router app renders AND hydrates through rango's
// generated host RSC entry (hostRouter.match()), in BOTH dev and production. The
// fixture lives at e2e/test-app/.host-fixture and is served by the host webServer
// entries in playwright.config.ts.
//
// Routing is driven by the host-override COOKIE on a single localhost origin (the
// supported dev workflow): one origin keeps client modules same-origin. The
// host-dev-warmup project primes the dev server's dep optimizer first, so dev
// client boot is fast (no cold-import noise). Real Host-header routing of the
// Vercel Build Output is covered separately by examples/vercel-multi-router's smoke.
const HOST_DEV_PORT = 5198;
const HOST_PREVIEW_PORT = 5199;

function hostRoutingTests(port: number) {
  const visit = async (page: import("@playwright/test").Page, host: string) => {
    await page.context().clearCookies();
    await page
      .context()
      .addCookies([
        { name: "x-rango-host", value: host, url: `http://localhost:${port}` },
      ]);
    return page.goto(`http://localhost:${port}/`);
  };

  test("dispatches each matched host to its sub-app", async ({ page }) => {
    const a = await visit(page, "a.localhost");
    expect(a?.status()).toBe(200);
    await expect(page.getByTestId("app")).toHaveText("App A home");
    // Prove the client booted (not just SSR text), and let hydration settle.
    await waitForHydration(page);

    const b = await visit(page, "b.localhost");
    expect(b?.status()).toBe(200);
    await expect(page.getByTestId("app")).toHaveText("App B home");
    await waitForHydration(page);
  });

  test("returns 404 for an unmatched host (generated entry catches NoRouteMatchError)", async ({
    page,
  }) => {
    const res = await visit(page, "c.localhost");
    expect(res?.status()).toBe(404);
  });
}

test.describe("host router on node preset (dev)", () =>
  hostRoutingTests(HOST_DEV_PORT));

test.describe("host router on node preset (production)", () =>
  hostRoutingTests(HOST_PREVIEW_PORT));
