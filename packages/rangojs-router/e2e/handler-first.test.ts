import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import {
  blockPrefetch,
  expectNoPageError,
  expectNoReload,
  waitForHydration,
} from "./helper";

function handlerFirstSuite(f: Fixture) {
  test("route handler ctx.set() is visible to layout via ctx.get()", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/handler-first"));
    await waitForHydration(page);

    // Handler rendered
    await expect(page.getByTestId("handler-first-title")).toHaveText(
      "Handler First",
    );

    // Orphan layout sees the value set by the handler
    await expect(page.getByTestId("layout-get-value")).toHaveText(
      "Layout got: from-handler",
    );
  });

  test("route handler ctx.set() is visible to parallel via ctx.get()", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/handler-first"));
    await waitForHydration(page);

    // Parallel sidebar sees the value set by the handler
    await expect(page.getByTestId("sidebar-get-value")).toHaveText(
      "Sidebar got: from-handler",
    );
  });

  test("cache scope: handler ctx.set() visible to parallel via SSR", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/handler-first/cache-scope"));
    await waitForHydration(page);

    const handlerTs = await page
      .getByTestId("cache-scope-handler-ts")
      .textContent();
    const sidebarTs = await page
      .getByTestId("cache-scope-sidebar-ts")
      .textContent();

    expect(handlerTs).toBeTruthy();
    expect(sidebarTs).toBe(handlerTs);
  });
}

test.describe("handler-first execution order (dev)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  handlerFirstSuite(f);
});

test.describe("handler-first execution order (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  handlerFirstSuite(f);
});

// Revalidation + cache mix: client navigation cache behavior with
// revalidate(() => true) and cache({ ttl }) mixing.

function revalidateCacheMixSuite(f: Fixture) {
  test("revalidate(() => true) forces fresh content on client navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    // Each click makes its own request. Production prefetches links in the
    // viewport, and a prefetch renders the route fresh without revalidate.
    await blockPrefetch(page);

    // SSR load — get initial timestamp
    await page.goto(f.url("/handler-first"));
    await waitForHydration(page);
    await using __ = await expectNoReload(page);

    const timestamp = page.getByTestId("handler-first-timestamp");
    const ts0 = await timestamp.textContent();
    expect(ts0).toBeTruthy();

    // Same URL: params and search are unchanged and the route stays on
    // screen, so the default holds it. Only revalidate(() => true) re-renders.
    await page.getByTestId("link-to-self").click();
    await expect(timestamp).not.toHaveText(ts0!);

    const ts1 = await timestamp.textContent();
    expect(ts1).toBeTruthy();

    // SPA navigate away to cached route
    await page.getByTestId("link-to-cached").click();
    await expect(page.getByTestId("cache-scope-title")).toBeVisible();

    // SPA navigate back — the browser still holds this route's segment and
    // the default reuses it; revalidate(() => true) forces fresh render
    await page.getByTestId("link-to-uncached").click();
    await expect(page.getByTestId("handler-first-title")).toBeVisible();

    const ts2 = await timestamp.textContent();

    // Timestamp must change — revalidate forced a fresh server render
    expect(ts2).not.toBe(ts1);
  });

  test("cached route serves from cache while uncached route is always fresh", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // SSR load uncached route
    await page.goto(f.url("/handler-first"));
    await waitForHydration(page);

    const uncachedTs1 = await page
      .getByTestId("handler-first-timestamp")
      .textContent();

    // SPA navigate to cached route (cache miss — first visit)
    await page.getByTestId("link-to-cached").click();
    await expect(page.getByTestId("cache-scope-title")).toBeVisible();

    const cachedHandlerTs1 = await page
      .getByTestId("cache-scope-handler-ts")
      .textContent();
    const cachedSidebarTs1 = await page
      .getByTestId("cache-scope-sidebar-ts")
      .textContent();

    // Sidebar reads handler's timestamp via ctx.get()
    expect(cachedSidebarTs1).toBe(cachedHandlerTs1);

    // Poll for cache hit: the async cache write runs in the background and
    // under heavy load can take longer than any fixed timeout. Navigate
    // back-and-forth until the cached route returns the same timestamp.
    await expect
      .poll(
        async () => {
          // Navigate to uncached route (fresh content)
          await page.getByTestId("link-to-uncached").click();
          await expect(page.getByTestId("handler-first-title")).toBeVisible();

          // Navigate to cached route — check if cache hit
          await page.getByTestId("link-to-cached").click();
          await expect(page.getByTestId("cache-scope-title")).toBeVisible();

          return page.getByTestId("cache-scope-handler-ts").textContent();
        },
        { timeout: 15000, intervals: [1000, 2000, 3000] },
      )
      .toBe(cachedHandlerTs1);

    const cachedSidebarTs2 = await page
      .getByTestId("cache-scope-sidebar-ts")
      .textContent();
    expect(cachedSidebarTs2).toBe(cachedHandlerTs1);
  });
}

test.describe("revalidate and cache mix (dev)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  revalidateCacheMixSuite(f);
});

test.describe("revalidate and cache mix (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  revalidateCacheMixSuite(f);
});
