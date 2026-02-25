import { test, expect } from "@playwright/test";
import { useFixture } from "./fixture";

test.describe("reverse", () => {
  const f = useFixture({ root: ".", mode: "dev" });

  test("should resolve routes from lazy includes via ctx.reverse()", async ({
    request,
  }) => {
    const res = await request.get(f.url("/reverse-test"));
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
    expect(results["shop.product.benchFirst"]).toBe(
      "/shop/product/bench/first",
    );
    expect(results["shop.product.benchLast"]).toBe("/shop/product/bench/last");

    // Routes from lazy include("/shop", ...) → include("/category", ...)
    expect(results["shop.category.cat1"]).toBe("/shop/category/1");
    expect(results["shop.category.cat42"]).toBe("/shop/category/42");
    expect(results["shop.category.cat100"]).toBe("/shop/category/100");
  });
});
