import { describe, it, expect } from "vitest";
import { generateManifest } from "../generate-manifest";
import { urls, type UrlPatterns } from "../../urls";

describe("generateManifest", () => {
  it("should extract routes from simple urlpatterns", () => {
    const urlpatterns = urls(({ path }) => [
      path("/", () => null, { name: "home" }),
      path("/about", () => null, { name: "about" }),
    ]);

    const manifest = generateManifest(urlpatterns);

    expect(manifest.routeManifest).toEqual({
      home: "/",
      about: "/about",
    });
    expect(manifest.prefixTree).toEqual({});
  });

  it("should extract routes from nested includes", () => {
    const apiPatterns = urls(({ path }) => [
      path("/users", () => null, { name: "users" }),
      path("/posts", () => null, { name: "posts" }),
    ]);

    const urlpatterns = urls(({ path, include }) => [
      path("/", () => null, { name: "home" }),
      include("/api", apiPatterns, { name: "api" }),
    ]);

    const manifest = generateManifest(urlpatterns);

    expect(manifest.routeManifest).toHaveProperty("home", "/");
    expect(manifest.routeManifest).toHaveProperty("api.users", "/api/users");
    expect(manifest.routeManifest).toHaveProperty("api.posts", "/api/posts");
    expect(manifest.prefixTree).toHaveProperty("/api");
    expect(manifest.prefixTree["/api"].staticPrefix).toBe("/api");
  });

  it("should extract routes from lazy includes", () => {
    const lazyPatterns = urls(({ path }) => [
      path("/items", () => null, { name: "items" }),
    ]);

    const urlpatterns = urls(({ path, include }) => [
      path("/", () => null, { name: "home" }),
      // All includes are lazy by default
      include("/shop", lazyPatterns, { name: "shop" }),
    ]);

    const manifest = generateManifest(urlpatterns);

    // Lazy includes should still be extracted at build time
    expect(manifest.routeManifest).toHaveProperty("home", "/");
    expect(manifest.routeManifest).toHaveProperty("shop.items", "/shop/items");
    expect(manifest.prefixTree).toHaveProperty("/shop");
  });

  it("should handle nested includes with proper prefixes", () => {
    const productPatterns = urls(({ path }) => [
      path("/:id", () => null, { name: "detail" }),
    ]);

    const categoryPatterns = urls(({ path }) => [
      path("/:slug", () => null, { name: "view" }),
    ]);

    const shopPatterns = urls(({ include }) => [
      include("/product", productPatterns, { name: "product" }),
      include("/category", categoryPatterns, { name: "category" }),
    ]);

    const urlpatterns = urls(({ path, include }) => [
      path("/", () => null, { name: "home" }),
      include("/shop", shopPatterns, { name: "shop" }),
    ]);

    const manifest = generateManifest(urlpatterns);

    expect(manifest.routeManifest).toHaveProperty("home", "/");
    expect(manifest.routeManifest).toHaveProperty(
      "shop.product.detail",
      "/shop/product/:id"
    );
    expect(manifest.routeManifest).toHaveProperty(
      "shop.category.view",
      "/shop/category/:slug"
    );

    // Check nested prefix tree
    expect(manifest.prefixTree).toHaveProperty("/shop");
    const shopNode = manifest.prefixTree["/shop"];
    expect(shopNode.children).toHaveProperty("/shop/product");
    expect(shopNode.children).toHaveProperty("/shop/category");
  });

  it("should include generatedAt timestamp", () => {
    const urlpatterns = urls(({ path }) => [
      path("/", () => null, { name: "home" }),
    ]);

    const manifest = generateManifest(urlpatterns);

    expect(manifest.generatedAt).toBeDefined();
    expect(new Date(manifest.generatedAt).getTime()).not.toBeNaN();
  });

  it("should extract search schemas for named routes", () => {
    const urlpatterns = urls(({ path }) => [
      path("/search/:category", () => null, {
        name: "search.detail",
        search: { q: "string?", active: "boolean?" },
      }),
      path("/search", () => null, {
        name: "search.index",
        search: { q: "string", page: "number?", sort: "string?" },
      }),
    ]);

    const manifest = generateManifest(urlpatterns);

    expect(manifest.routeSearchSchemas).toEqual({
      "search.detail": { q: "string?", active: "boolean?" },
      "search.index": { q: "string", page: "number?", sort: "string?" },
    });
  });

  it("should extract search schemas from included patterns with prefixes", () => {
    const searchPatterns = urls(({ path }) => [
      path("/", () => null, {
        name: "index",
        search: { q: "string", page: "number?", sort: "string?" },
      }),
      path("/:category", () => null, {
        name: "detail",
        search: { q: "string?", active: "boolean?" },
      }),
    ]);

    const urlpatterns = urls(({ include }) => [
      include("/search", searchPatterns, { name: "search" }),
    ]);

    const manifest = generateManifest(urlpatterns);

    expect(manifest.routeSearchSchemas).toEqual({
      "search.detail": { q: "string?", active: "boolean?" },
      "search.index": { q: "string", page: "number?", sort: "string?" },
    });
  });
});
