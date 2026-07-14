import { expect, test, type Request } from "@playwright/test";
import { isPrefetchRequest } from "@rangojs/router/testing/e2e";
import { useFixture, type Fixture } from "./fixture";
import { waitForHydration } from "./helper";

function isInvalidationTarget(request: Request): boolean {
  const url = new URL(request.url());
  return (
    isPrefetchRequest(request) &&
    url.pathname === "/__prefetch-scope/target" &&
    url.searchParams.get("invalidation") === "1"
  );
}

function runDelegatedPrefetchScopeSpec(f: Fixture): void {
  test("plain-anchor prefetch stays within the router URL namespace", async ({
    page,
  }) => {
    const prefetches: string[] = [];
    page.on("request", (request) => {
      if (isPrefetchRequest(request)) prefetches.push(request.url());
    });

    await page.goto(f.url("/__prefetch-scope"));
    await waitForHydration(page);
    await page.getByTestId("prefetch-hash-only").scrollIntoViewIfNeeded();

    await expect
      .poll(() =>
        prefetches.some(
          (url) => new URL(url).pathname === "/__prefetch-scope/target",
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        prefetches.some(
          (url) => new URL(url).pathname === "/__prefetch-scope/promo/50%off",
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        prefetches.some(
          (url) => new URL(url).pathname === "/__prefetch-scope/target.js",
        ),
      )
      .toBe(true);
    await page.waitForTimeout(500);
    expect(
      prefetches.some(
        (url) => new URL(url).pathname === "/__prefetch-scope/files/report.pdf",
      ),
    ).toBe(false);
    expect(prefetches.some((url) => new URL(url).pathname === "/about")).toBe(
      false,
    );
    expect(
      prefetches.some((url) => new URL(url).pathname === "/__prefetch-scope"),
    ).toBe(false);
    expect(
      prefetches.some(
        (url) => new URL(url).pathname === "/__prefetch-scope/logout",
      ),
    ).toBe(false);
    expect(
      prefetches.some(
        (url) => new URL(url).pathname === "/__prefetch-scope/svg-target",
      ),
    ).toBe(false);
    expect(
      prefetches.some(
        (url) =>
          new URL(url).pathname.toLowerCase() === "/__prefetch-scope%2fadmin",
      ),
    ).toBe(false);
    expect(
      prefetches.some(
        (url) => new URL(url).searchParams.get("container-scope") === "none",
      ),
    ).toBe(false);

    const realmIdentity = await page.evaluate(() => {
      const iframe = document.createElement("iframe");
      document.body.appendChild(iframe);
      const viewportLink = iframe.contentDocument!.createElement("a");
      const hoverLink = iframe.contentDocument!.createElement("a");
      const sourcePrototype = Object.getPrototypeOf(viewportLink);
      const adoptedViewportLink = document.adoptNode(viewportLink);
      const adoptedHoverLink = document.adoptNode(hoverLink);
      iframe.remove();

      adoptedViewportLink.href =
        "/__prefetch-scope/target?cross-realm-viewport=1";
      adoptedViewportLink.textContent = "Cross-realm viewport target";
      document.body.appendChild(adoptedViewportLink);

      adoptedHoverLink.href = "/__prefetch-scope/target?cross-realm-hover=1";
      adoptedHoverLink.textContent = "Cross-realm hover target";
      adoptedHoverLink.style.cssText = "position:absolute;top:100000px;left:0";
      document.body.appendChild(adoptedHoverLink);
      adoptedHoverLink.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true }),
      );

      return {
        current: adoptedViewportLink instanceof HTMLAnchorElement,
        source: sourcePrototype.isPrototypeOf(adoptedViewportLink),
      };
    });
    expect(realmIdentity).toEqual({ current: false, source: true });
    await expect
      .poll(() =>
        prefetches.some(
          (url) =>
            new URL(url).searchParams.get("cross-realm-viewport") === "1",
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        prefetches.some(
          (url) => new URL(url).searchParams.get("cross-realm-hover") === "1",
        ),
      )
      .toBe(true);

    const navigationRequest = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname ===
          "/__prefetch-scope/files/report.pdf" &&
        new URL(request.url()).searchParams.get("_rsc_partial") === "true" &&
        !isPrefetchRequest(request),
    );
    await page.getByTestId("prefetch-resource").click();
    const request = await navigationRequest;
    expect(new URL(request.url()).searchParams.get("_rsc_partial")).toBe(
      "true",
    );
  });

  test("initial payload carries the delegated-prefetch scope metadata", async ({
    page,
  }) => {
    const response = await page.request.get(
      f.url("/__prefetch-scope?__rsc=1"),
      { headers: { "X-Rango-State": "test:1" } },
    );

    expect(response.status()).toBe(200);
    const body = await response.text();
    expect(body).toMatch(/"defaultPrefetch"\s*:\s*"viewport"/);
    expect(body).toMatch(/"basename"\s*:\s*"\/__prefetch-scope"/);
  });

  test("a hash-only anchor becomes eligible after navigation", async ({
    page,
  }) => {
    const prefetches: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        isPrefetchRequest(request) &&
        url.pathname === "/__prefetch-scope" &&
        url.searchParams.get("parked") === "1"
      ) {
        prefetches.push(request.url());
      }
    });

    await page.goto(f.url("/__prefetch-scope?parked=1"));
    await waitForHydration(page);
    await page.evaluate(() => {
      const link = document.createElement("a");
      link.href = "/__prefetch-scope?parked=1#hash-target";
      link.textContent = "Persistent hash link";
      link.style.cssText =
        "position:fixed;top:0;left:0;pointer-events:none;z-index:-1";
      document.body.appendChild(link);
    });
    await page.waitForTimeout(500);
    expect(prefetches).toHaveLength(0);

    await page.getByTestId("prefetch-target").click();
    await expect(page).toHaveURL(/\/__prefetch-scope\/target$/);
    await expect.poll(() => prefetches.length).toBeGreaterThan(0);
  });

  test("cache invalidation re-warms a persistent plain anchor", async ({
    page,
  }) => {
    const targetRequests: Request[] = [];
    page.on("request", (request) => {
      if (isInvalidationTarget(request)) targetRequests.push(request);
    });

    await page.goto(f.url("/__prefetch-scope"));
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

    await page.goto(f.url("/__prefetch-scope"));
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
    await page.getByTestId("counter-increment").click();
    const request = await rewarmed;

    expect(request.headers()["x-rango-state"]).toBeTruthy();
    expect(request.headers()["x-rango-state"]).not.toBe(initialState);
    expect(await anchor!.evaluate((element) => element.isConnected)).toBe(true);
  });
}

test.describe("delegated-prefetch-scope", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  runDelegatedPrefetchScopeSpec(f);
});

test.describe("delegated-prefetch-scope (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  runDelegatedPrefetchScopeSpec(f);
});
