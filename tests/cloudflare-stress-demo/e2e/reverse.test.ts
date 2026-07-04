import { test, expect, type APIRequestContext } from "@playwright/test";
import { useFixture } from "./fixture";

// ctx.reverse() across lazy includes, in BOTH modes — this suite was dev-only
// until 2026-07 (a production-coverage gap): the reverse map is built from
// build-time discovery in production and runtime discovery in dev, so the two
// can diverge exactly here.
//
// Direct `vite` commands (not `pnpm dev/preview`) so the suite runs locally
// without tripping the pnpm verifyDepsBeforeRun -> lefthook install hook.

async function expectReverseResolvesLazyIncludes(
  request: APIRequestContext,
  url: (u: string) => string,
) {
  const res = await request.get(url("/reverse-test"));
  expect(res.status()).toBe(200);

  const results = await res.json();

  // Top-level routes
  expect(results["home"]).toBe("/");

  // Routes from lazy include("/api", ...)
  expect(results["api.benchFirst"]).toBe("/api/bench/first");
  expect(results["api.benchLast"]).toBe("/api/bench/last");

  // Routes from lazy include("/shop", ...) → include("/product", ...)
  expect(results["shop.home"]).toBe("/shop");
  expect(results["shop.product.item1"]).toBe("/shop/product/1");
  expect(results["shop.product.item42"]).toBe("/shop/product/42");
  expect(results["shop.product.item100"]).toBe("/shop/product/100");
  expect(results["shop.product.benchFirst"]).toBe("/shop/product/bench/first");
  expect(results["shop.product.benchLast"]).toBe("/shop/product/bench/last");

  // Routes from lazy include("/shop", ...) → include("/category", ...)
  expect(results["shop.category.cat1"]).toBe("/shop/category/1");
  expect(results["shop.category.cat42"]).toBe("/shop/category/42");
  expect(results["shop.category.cat100"]).toBe("/shop/category/100");
}

test.describe("reverse (dev)", () => {
  const f = useFixture({ root: ".", command: "node_modules/.bin/vite dev" });

  test("should resolve routes from lazy includes via ctx.reverse()", async ({
    request,
  }) => {
    await expectReverseResolvesLazyIncludes(request, f.url);
  });
});

test.describe("reverse (production)", () => {
  const f = useFixture({
    root: ".",
    command: "node_modules/.bin/vite preview",
  });

  test("should resolve routes from lazy includes via ctx.reverse()", async ({
    request,
  }) => {
    await expectReverseResolvesLazyIncludes(request, f.url);
  });
});
