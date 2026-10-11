import { describe, expect, it } from "vitest";
import { runRevalidate } from "@rangojs/router/testing";
import { productData } from "../src/urls/client-shop.predicates.js";

/**
 * Dogfood of runRevalidate against the /client-shop product loaders'
 * revalidate() predicate, which runs on the server like a urls() loader's.
 */
describe("client-shop productData", () => {
  const product = (slug: string) => ({
    currentUrl: "/client-shop/product/a",
    nextUrl: `/client-shop/product/${slug}`,
    currentParams: { slug: "a" },
    nextParams: { slug },
  });

  it("re-runs on a slug change and holds on a tab change", async () => {
    expect(await runRevalidate(productData, product("b"))).toBe(true);
    expect(
      await runRevalidate(productData, {
        ...product("a"),
        nextUrl: "/client-shop/product/a?tab=reviews",
      }),
    ).toBe(false);
  });

  it("holds on any action (add-to-cart)", async () => {
    expect(
      await runRevalidate(productData, {
        ...product("a"),
        action: "src/handlers/shop/actions/shop.actions.ts#addToCart",
      }),
    ).toBe(false);
  });
});
