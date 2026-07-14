import { test, expect, type Request } from "@playwright/test";
import { checkoutPortOffset } from "@shared/e2e";
import { isPrefetchRequest, waitForHydration } from "./helper";

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
// Keep the 5296/5297 bases in sync with the HOST_*_PORT constants in
// playwright.config.ts. Chosen to not collide with tests/cloudflare-basic
// (5198/5199). This file builds absolute URLs, so it applies the same
// checkoutPortOffset() the config does — one derivation, no drift.
const PORT_OFFSET = checkoutPortOffset();
const HOST_DEV_PORT = 5296 + PORT_OFFSET;
const HOST_PREVIEW_PORT = 5297 + PORT_OFFSET;

function isInvalidationTarget(request: Request): boolean {
  const url = new URL(request.url());
  return (
    isPrefetchRequest(request) &&
    url.pathname === "/" &&
    url.searchParams.get("delegated-prefetch") === "1"
  );
}

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

  test("cache invalidation re-warms a persistent plain anchor", async ({
    page,
  }) => {
    const targetRequests: Request[] = [];
    page.on("request", (request) => {
      if (isInvalidationTarget(request)) targetRequests.push(request);
    });

    await visit(page, "a.localhost");
    await waitForHydration(page);
    await expect.poll(() => targetRequests.length).toBeGreaterThan(0);
    const initialState = targetRequests[0]!.headers()["x-rango-state"];
    expect(initialState).toBeTruthy();
    const anchor = await page
      .getByTestId("prefetch-invalidation-target")
      .elementHandle();

    const rewarmed = page.waitForRequest(
      (request) =>
        isInvalidationTarget(request) &&
        request.headers()["x-rango-state"] !== initialState,
    );
    await page.getByTestId("prefetch-invalidation-button").click();
    const request = await rewarmed;

    expect(request.headers()["x-rango-state"]).toBeTruthy();
    expect(request.headers()["x-rango-state"]).not.toBe(initialState);
    expect(await anchor!.evaluate((element) => element.isConnected)).toBe(true);
  });

  test("server-action invalidation re-warms after the action fence", async ({
    page,
  }) => {
    const targetRequests: Request[] = [];
    page.on("request", (request) => {
      if (isInvalidationTarget(request)) targetRequests.push(request);
    });

    await visit(page, "a.localhost");
    await waitForHydration(page);
    await expect.poll(() => targetRequests.length).toBeGreaterThan(0);
    const initialState = targetRequests[0]!.headers()["x-rango-state"];
    const anchor = await page
      .getByTestId("prefetch-invalidation-target")
      .elementHandle();

    const rewarmed = page.waitForRequest(
      (request) =>
        isInvalidationTarget(request) &&
        request.headers()["x-rango-state"] !== initialState,
    );
    await page.getByTestId("prefetch-action-invalidation-button").click();
    const request = await rewarmed;

    expect(request.headers()["x-rango-state"]).toBeTruthy();
    expect(request.headers()["x-rango-state"]).not.toBe(initialState);
    expect(await anchor!.evaluate((element) => element.isConnected)).toBe(true);
  });
}

test.describe("host router on node preset (dev)", () =>
  hostRoutingTests(HOST_DEV_PORT));

test.describe("host router on node preset (production)", () =>
  hostRoutingTests(HOST_PREVIEW_PORT));
