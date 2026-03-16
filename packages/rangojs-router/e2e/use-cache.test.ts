import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * Tests for the "use cache" directive — basic caching, boundary enforcement,
 * and JSON endpoints.
 *
 * Validates file-level and function-level "use cache" transforms,
 * named cache profiles, cookies()/headers() boundary guards,
 * branded runtime checks, and JSON endpoint caching.
 *
 * Strategy: cached functions embed Date.now() + Math.random() in their
 * return values. On cache hit the values are identical to the first call.
 * On cache miss they differ.
 */

// ============================================================================
// Dev mode tests
// ============================================================================

test.describe("use-cache basic", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });

  test("file-level use cache returns cached data on second request", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // First visit — cache miss, runs getBasicTimestamp()
    await page.goto(f.url("/use-cache-test/basic"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-basic-page")).toBeVisible();
    const ts1 = await page.getByTestId("use-cache-basic-ts").textContent();
    const rand1 = await page.getByTestId("use-cache-basic-rand").textContent();

    expect(ts1).toMatch(/^\d+$/);
    expect(rand1).toMatch(/^0\.\d+$/);

    // Navigate away
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Second visit — should be a cache hit (same ts and rand)
    await page.goto(f.url("/use-cache-test/basic"));
    await waitForHydration(page);

    const ts2 = await page.getByTestId("use-cache-basic-ts").textContent();
    const rand2 = await page.getByTestId("use-cache-basic-rand").textContent();

    expect(ts2).toBe(ts1);
    expect(rand2).toBe(rand1);
  });

  test("different args produce different cache entries", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Visit category "fruits"
    await page.goto(f.url("/use-cache-test/with-args/fruits"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-args-category")).toHaveText(
      "fruits",
    );
    const fruitTs = await page.getByTestId("use-cache-args-ts").textContent();
    const fruitRand = await page
      .getByTestId("use-cache-args-rand")
      .textContent();

    // Visit category "veggies" — different cache key
    await page.goto(f.url("/use-cache-test/with-args/veggies"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-args-category")).toHaveText(
      "veggies",
    );
    const veggieTs = await page.getByTestId("use-cache-args-ts").textContent();

    // Different category should have different timestamp (cache miss)
    expect(veggieTs).not.toBe(fruitTs);

    // Revisit "fruits" — should be cache hit
    await page.goto(f.url("/use-cache-test/with-args/fruits"));
    await waitForHydration(page);

    const fruitTs2 = await page.getByTestId("use-cache-args-ts").textContent();
    const fruitRand2 = await page
      .getByTestId("use-cache-args-rand")
      .textContent();

    expect(fruitTs2).toBe(fruitTs);
    expect(fruitRand2).toBe(fruitRand);
  });

  test("named profile use cache: short works", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/use-cache-test/named-profile"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-profile-page")).toBeVisible();
    const ts1 = await page.getByTestId("use-cache-profile-ts").textContent();
    expect(ts1).toMatch(/^\d+$/);

    // Navigate away and back — should hit cache
    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/use-cache-test/named-profile"));
    await waitForHydration(page);

    const ts2 = await page.getByTestId("use-cache-profile-ts").textContent();
    expect(ts2).toBe(ts1);
  });

  test("plain data JSON endpoint returns cached data", async ({ request }) => {
    // First request — cache miss
    const res1 = await request.get(f.url("/use-cache-test/plain-data"));
    expect(res1.status()).toBe(200);
    const body1 = await res1.json();
    expect(typeof body1.data.ts).toBe("number");
    expect(typeof body1.data.rand).toBe("number");

    // Small delay for async cache write
    await new Promise((r) => setTimeout(r, 200));

    // Second request — cache hit, same data
    const res2 = await request.get(f.url("/use-cache-test/plain-data"));
    expect(res2.status()).toBe(200);
    const body2 = await res2.json();

    expect(body2.data.ts).toBe(body1.data.ts);
    expect(body2.data.rand).toBe(body1.data.rand);
  });

  test("use cache functions are branded at runtime", async ({ request }) => {
    const res = await request.get(f.url("/use-cache-test/brand-check"));
    expect(res.status()).toBe(200);
    const body = await res.json();

    // File-level "use cache" function should be branded
    expect(body.data.cachedFnBranded).toBe(true);
    // Plain function should not be branded
    expect(body.data.plainFnBranded).toBe(false);
  });

  test("cookies() throws inside a 'use cache' function", async ({
    request,
  }) => {
    const res = await request.get(f.url("/use-cache-test/guard-cookies"));
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.threw).toBe(true);
    expect(body.data.message).toMatch(/cookies\(\) cannot be called inside/i);
    expect(body.data.message).toMatch(/cache key/i);
  });

  test("headers() throws inside a 'use cache' function", async ({
    request,
  }) => {
    const res = await request.get(f.url("/use-cache-test/guard-headers"));
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body.data.threw).toBe(true);
    expect(body.data.message).toMatch(/headers\(\) cannot be called inside/i);
  });

  test("ctx.set() throws inside a 'use cache' function", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/use-cache-test/guard-ctx-set"));
    await waitForHydration(page);

    await expect(page.getByTestId("guard-ctx-set-threw")).toHaveText("true");
    const message = await page
      .getByTestId("guard-ctx-set-message")
      .textContent();
    expect(message).toMatch(/ctx\.set\(\) cannot be called inside/i);
  });

  test("ctx.headers.set() throws inside a 'use cache' function", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/use-cache-test/guard-ctx-headers-set"));
    await waitForHydration(page);

    await expect(page.getByTestId("guard-ctx-headers-set-threw")).toHaveText(
      "true",
    );
    const message = await page
      .getByTestId("guard-ctx-headers-set-message")
      .textContent();
    expect(message).toMatch(/ctx\.headers\(\) cannot be called inside/i);
  });

  test("path.json with use cache: params differentiate entries", async ({
    request,
  }) => {
    // First request — cache miss for id=1
    const res1 = await request.get(f.url("/use-cache-test/json-cached/1"));
    expect(res1.status()).toBe(200);
    const body1 = await res1.json();
    expect(body1.data.id).toBe("1");

    // Small delay for async cache write
    await new Promise((r) => setTimeout(r, 200));

    // Second request with same id — cache hit
    const res2 = await request.get(f.url("/use-cache-test/json-cached/1"));
    expect(res2.status()).toBe(200);
    const body2 = await res2.json();
    expect(body2.data.ts).toBe(body1.data.ts);
    expect(body2.data.rand).toBe(body1.data.rand);

    // Different id — cache miss, different entry
    const res3 = await request.get(f.url("/use-cache-test/json-cached/2"));
    expect(res3.status()).toBe(200);
    const body3 = await res3.json();
    expect(body3.data.id).toBe("2");
    expect(body3.data.ts).not.toBe(body1.data.ts);
  });
});

// ============================================================================
// Production mode tests
// ============================================================================

test.describe("use-cache basic (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("file-level use cache returns cached data on second request", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/use-cache-test/basic"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-basic-page")).toBeVisible();
    const ts1 = await page.getByTestId("use-cache-basic-ts").textContent();
    const rand1 = await page.getByTestId("use-cache-basic-rand").textContent();

    expect(ts1).toMatch(/^\d+$/);
    expect(rand1).toMatch(/^0\.\d+$/);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/use-cache-test/basic"));
    await waitForHydration(page);

    const ts2 = await page.getByTestId("use-cache-basic-ts").textContent();
    const rand2 = await page.getByTestId("use-cache-basic-rand").textContent();

    expect(ts2).toBe(ts1);
    expect(rand2).toBe(rand1);
  });

  test("different args produce different cache entries", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/use-cache-test/with-args/fruits"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-args-category")).toHaveText(
      "fruits",
    );
    const fruitTs = await page.getByTestId("use-cache-args-ts").textContent();
    const fruitRand = await page
      .getByTestId("use-cache-args-rand")
      .textContent();

    await page.goto(f.url("/use-cache-test/with-args/veggies"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-args-category")).toHaveText(
      "veggies",
    );
    const veggieTs = await page.getByTestId("use-cache-args-ts").textContent();
    expect(veggieTs).not.toBe(fruitTs);

    await page.goto(f.url("/use-cache-test/with-args/fruits"));
    await waitForHydration(page);

    const fruitTs2 = await page.getByTestId("use-cache-args-ts").textContent();
    const fruitRand2 = await page
      .getByTestId("use-cache-args-rand")
      .textContent();

    expect(fruitTs2).toBe(fruitTs);
    expect(fruitRand2).toBe(fruitRand);
  });

  test("named profile use cache: short works", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/use-cache-test/named-profile"));
    await waitForHydration(page);

    await expect(page.getByTestId("use-cache-profile-page")).toBeVisible();
    const ts1 = await page.getByTestId("use-cache-profile-ts").textContent();

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/use-cache-test/named-profile"));
    await waitForHydration(page);

    const ts2 = await page.getByTestId("use-cache-profile-ts").textContent();
    expect(ts2).toBe(ts1);
  });

  test("plain data JSON endpoint returns cached data", async ({ request }) => {
    const res1 = await request.get(f.url("/use-cache-test/plain-data"));
    expect(res1.status()).toBe(200);
    const body1 = await res1.json();
    expect(typeof body1.data.ts).toBe("number");
    expect(typeof body1.data.rand).toBe("number");

    await new Promise((r) => setTimeout(r, 200));

    const res2 = await request.get(f.url("/use-cache-test/plain-data"));
    expect(res2.status()).toBe(200);
    const body2 = await res2.json();

    expect(body2.data.ts).toBe(body1.data.ts);
    expect(body2.data.rand).toBe(body1.data.rand);
  });

  test("use cache functions are branded at runtime", async ({ request }) => {
    const res = await request.get(f.url("/use-cache-test/brand-check"));
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body.data.cachedFnBranded).toBe(true);
    expect(body.data.plainFnBranded).toBe(false);
  });

  test("cookies() throws inside a 'use cache' function", async ({
    request,
  }) => {
    const res = await request.get(f.url("/use-cache-test/guard-cookies"));
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.threw).toBe(true);
    expect(body.data.message).toMatch(/cookies\(\) cannot be called inside/i);
    expect(body.data.message).toMatch(/cache key/i);
  });

  test("headers() throws inside a 'use cache' function", async ({
    request,
  }) => {
    const res = await request.get(f.url("/use-cache-test/guard-headers"));
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body.data.threw).toBe(true);
    expect(body.data.message).toMatch(/headers\(\) cannot be called inside/i);
  });

  test("ctx.set() throws inside a 'use cache' function", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/use-cache-test/guard-ctx-set"));
    await waitForHydration(page);

    await expect(page.getByTestId("guard-ctx-set-threw")).toHaveText("true");
    const message = await page
      .getByTestId("guard-ctx-set-message")
      .textContent();
    expect(message).toMatch(/ctx\.set\(\) cannot be called inside/i);
  });

  test("ctx.headers.set() throws inside a 'use cache' function", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/use-cache-test/guard-ctx-headers-set"));
    await waitForHydration(page);

    await expect(page.getByTestId("guard-ctx-headers-set-threw")).toHaveText(
      "true",
    );
    const message = await page
      .getByTestId("guard-ctx-headers-set-message")
      .textContent();
    expect(message).toMatch(/ctx\.headers\(\) cannot be called inside/i);
  });

  test("path.json with use cache: params differentiate entries", async ({
    request,
  }) => {
    const res1 = await request.get(f.url("/use-cache-test/json-cached/1"));
    expect(res1.status()).toBe(200);
    const body1 = await res1.json();
    expect(body1.data.id).toBe("1");

    await new Promise((r) => setTimeout(r, 200));

    const res2 = await request.get(f.url("/use-cache-test/json-cached/1"));
    expect(res2.status()).toBe(200);
    const body2 = await res2.json();
    expect(body2.data.ts).toBe(body1.data.ts);
    expect(body2.data.rand).toBe(body1.data.rand);

    const res3 = await request.get(f.url("/use-cache-test/json-cached/2"));
    expect(res3.status()).toBe(200);
    const body3 = await res3.json();
    expect(body3.data.id).toBe("2");
    expect(body3.data.ts).not.toBe(body1.data.ts);
  });
});
