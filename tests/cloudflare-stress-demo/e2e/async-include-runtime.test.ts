import { test, expect, type APIRequestContext } from "@playwright/test";
import { useFixture } from "./fixture";

// Runtime coverage for async include(prefix, () => import("./routes")). The
// sibling reverse.test.ts / named-routes.test.ts only prove the reverse MAP and
// gen FILE carry the split-group names — both are populated from build-time
// discovery and resolve even if runtime matching 404s (exactly the dropped-
// Promise failure in router.ts that this exercises). These tests actually
// REQUEST the routes so the router's findMatch has to await each provider's
// import and, for /shop, splice its nested product/category entries.
//
// Direct `vite` commands (not `pnpm dev/preview`) so the suite runs locally
// without tripping the pnpm verifyDepsBeforeRun -> lefthook install hook.
//
// Bucketing: the build-server describe is titled "(production)" so it lands in
// the production grep; the dev describe must not contain that tag.

async function expectAsyncIncludeRoutes(
  request: APIRequestContext,
  url: (u: string) => string,
) {
  // Leaf async includes (each its own code-split chunk), JSON response routes.
  const jsonApi = await request.get(url("/json-api/health"));
  expect(jsonApi.status()).toBe(200);
  expect((await jsonApi.json()).status).toBe("ok");

  const api = await request.get(url("/api/bench/first"));
  expect(api.status()).toBe(200);
  expect((await api.json()).route).toBe("/api/bench/first");

  // Leaf async include carrying a path param (/site/:locale/...).
  const site = await request.get(url("/site/en/bench/first"));
  expect(site.status()).toBe(200);
  const siteBody = await site.json();
  expect(siteBody.route).toBe("/site/en/bench/first");
  expect(siteBody.params.locale).toBe("en");

  // NESTED async include: the shop module is imported on first hit, THEN its
  // product/category children are spliced. /shop is the module's own route.
  // ASYNC-WITHIN-ASYNC: /shop/product is ITSELF an async include(() => import())
  // inside the already-async shop module, so /shop/product/* chains two deferred
  // imports at runtime; /shop/category is an eager child for contrast.
  const shop = await request.get(url("/shop"));
  expect(shop.status()).toBe(200);
  expect((await shop.json()).route).toBe("/shop");

  const product = await request.get(url("/shop/product/bench/first"));
  expect(product.status()).toBe(200);
  expect((await product.json()).route).toBe("/shop/product/bench/first");

  const category = await request.get(url("/shop/category/bench/first"));
  expect(category.status()).toBe(200);
  expect((await category.json()).route).toBe("/shop/category/bench/first");
}

test.describe("async include routes (dev)", () => {
  const f = useFixture({ root: ".", command: "node_modules/.bin/vite dev" });

  test("resolves leaf and nested async includes at runtime", async ({
    request,
  }) => {
    await expectAsyncIncludeRoutes(request, f.url);
  });

  test("renders a nested async-include component route", async ({ page }) => {
    await page.goto(f.url("/shop/product/1"));
    await expect(page.getByRole("heading", { name: /Product/ })).toBeVisible();
  });
});

test.describe("async include routes (production)", () => {
  const f = useFixture({
    root: ".",
    command: "node_modules/.bin/vite preview",
  });

  test("resolves leaf and nested async includes at runtime", async ({
    request,
  }) => {
    await expectAsyncIncludeRoutes(request, f.url);
  });

  test("renders a nested async-include component route", async ({ page }) => {
    await page.goto(f.url("/shop/product/1"));
    await expect(page.getByRole("heading", { name: /Product/ })).toBeVisible();
  });
});
