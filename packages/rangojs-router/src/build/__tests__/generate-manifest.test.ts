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
      "/shop/product/:id",
    );
    expect(manifest.routeManifest).toHaveProperty(
      "shop.category.view",
      "/shop/category/:slug",
    );

    // Check nested prefix tree
    expect(manifest.prefixTree).toHaveProperty("/shop");
    const shopNode = manifest.prefixTree["/shop"];
    expect(shopNode.children).toHaveProperty("/shop/product");
    expect(shopNode.children).toHaveProperty("/shop/category");
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

  it("should include the same patterns under multiple prefixes without false cycle detection", () => {
    const shared = urls(({ path }) => [
      path("/health", () => null, { name: "health" }),
      path("/:id", () => null, { name: "detail" }),
    ]);

    const urlpatterns = urls(({ path, include }) => [
      path("/", () => null, { name: "home" }),
      include("/api", shared, { name: "api" }),
      include("/v2", shared, { name: "v2" }),
    ]);

    const manifest = generateManifest(urlpatterns);

    // Both mounts should be present — the second is NOT a cycle
    expect(manifest.routeManifest).toHaveProperty("home", "/");
    expect(manifest.routeManifest).toHaveProperty("api.health", "/api/health");
    expect(manifest.routeManifest).toHaveProperty("api.detail", "/api/:id");
    expect(manifest.routeManifest).toHaveProperty("v2.health", "/v2/health");
    expect(manifest.routeManifest).toHaveProperty("v2.detail", "/v2/:id");

    // Both prefix tree entries should exist
    expect(manifest.prefixTree).toHaveProperty("/api");
    expect(manifest.prefixTree).toHaveProperty("/v2");
  });

  it("should detect a real cycle (A includes B includes A)", () => {
    // eslint-disable-next-line prefer-const -- mutual reference
    let cycleB: UrlPatterns<any>;
    const cycleA: UrlPatterns<any> = urls(({ path, include }) => [
      path("/a", () => null, { name: "a" }),
      include("/b", cycleB!, { name: "b" }),
    ]);
    cycleB = urls(({ path, include }) => [
      path("/b", () => null, { name: "b" }),
      include("/a", cycleA, { name: "a" }),
    ]);

    const urlpatterns = urls(({ include }) => [
      include("/start", cycleA, { name: "start" }),
    ]);

    // Should not infinite-loop; the cycle is detected and one branch is skipped
    const manifest = generateManifest(urlpatterns);
    expect(manifest.routeManifest).toHaveProperty("start.a");
    expect(manifest.routeManifest).toHaveProperty("start.b.b");
    // The cyclic back-reference (b -> a -> b ...) should be cut
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
