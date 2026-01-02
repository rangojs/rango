import { describe, it, expect, beforeEach } from "vitest";
import {
  createRouteMap,
  registerRouteMap,
  getGlobalRouteMap,
} from "../route-map-builder";

describe("createRouteMap", () => {
  describe("basic route addition", () => {
    it("should create empty route map", () => {
      const builder = createRouteMap();
      expect(builder.routes).toEqual({});
    });

    it("should add routes without prefix", () => {
      const routes = {
        index: "/",
        about: "/about",
        contact: "/contact",
      };

      const builder = createRouteMap().add(routes);

      expect(builder.routes).toEqual({
        index: "/",
        about: "/about",
        contact: "/contact",
      });
    });

    it("should preserve route patterns exactly when no prefix", () => {
      const routes = {
        product: "/products/:slug",
        category: "/categories/:id/items",
      };

      const builder = createRouteMap().add(routes);

      expect(builder.routes).toEqual({
        product: "/products/:slug",
        category: "/categories/:id/items",
      });
    });
  });

  describe("prefixed routes", () => {
    it("should prefix route keys", () => {
      const routes = {
        index: "/",
        list: "/list",
      };

      const builder = createRouteMap().add(routes, "blog");

      expect(builder.routes["blog.index"]).toBeDefined();
      expect(builder.routes["blog.list"]).toBeDefined();
    });

    it("should prefix route patterns", () => {
      const routes = {
        list: "/posts",
        detail: "/posts/:slug",
      };

      const builder = createRouteMap().add(routes, "blog");

      expect(builder.routes["blog.list"]).toBe("/blog/posts");
      expect(builder.routes["blog.detail"]).toBe("/blog/posts/:slug");
    });

    it("should handle index route with prefix", () => {
      const routes = {
        index: "/",
      };

      const builder = createRouteMap().add(routes, "shop");

      // Index "/" with prefix becomes "/shop"
      expect(builder.routes["shop.index"]).toBe("/shop");
    });

    it("should handle nested prefixes in patterns", () => {
      const routes = {
        orders: "/account/orders",
        settings: "/account/settings",
      };

      const builder = createRouteMap().add(routes, "user");

      expect(builder.routes["user.orders"]).toBe("/user/account/orders");
      expect(builder.routes["user.settings"]).toBe("/user/account/settings");
    });
  });

  describe("chaining", () => {
    it("should support chaining multiple add calls", () => {
      const homeRoutes = { index: "/", about: "/about" };
      const blogRoutes = { list: "/posts", detail: "/posts/:slug" };
      const shopRoutes = { products: "/products", cart: "/cart" };

      const builder = createRouteMap()
        .add(homeRoutes)
        .add(blogRoutes, "blog")
        .add(shopRoutes, "shop");

      expect(builder.routes).toEqual({
        index: "/",
        about: "/about",
        "blog.list": "/blog/posts",
        "blog.detail": "/blog/posts/:slug",
        "shop.products": "/shop/products",
        "shop.cart": "/shop/cart",
      });
    });

    it("should return same builder instance for chaining", () => {
      const builder = createRouteMap();
      const returned = builder.add({ index: "/" });

      expect(returned).toBe(builder);
    });

    it("should accumulate routes across multiple adds", () => {
      const builder = createRouteMap();

      builder.add({ home: "/" });
      expect(Object.keys(builder.routes)).toHaveLength(1);

      builder.add({ about: "/about" });
      expect(Object.keys(builder.routes)).toHaveLength(2);

      builder.add({ contact: "/contact" });
      expect(Object.keys(builder.routes)).toHaveLength(3);
    });
  });

  describe("edge cases", () => {
    it("should handle empty routes object", () => {
      const builder = createRouteMap().add({});
      expect(builder.routes).toEqual({});
    });

    it("should handle routes with query parameters in pattern", () => {
      const routes = {
        search: "/search",
      };

      const builder = createRouteMap().add(routes, "api");
      expect(builder.routes["api.search"]).toBe("/api/search");
    });

    it("should handle deeply nested route patterns", () => {
      const routes = {
        nested: "/a/b/c/d/e",
      };

      const builder = createRouteMap().add(routes, "deep");
      expect(builder.routes["deep.nested"]).toBe("/deep/a/b/c/d/e");
    });

    it("should handle special characters in route keys", () => {
      const routes = {
        "products-list": "/products",
        "product_detail": "/products/:id",
      };

      const builder = createRouteMap().add(routes, "shop");

      expect(builder.routes["shop.products-list"]).toBe("/shop/products");
      expect(builder.routes["shop.product_detail"]).toBe("/shop/products/:id");
    });

    it("should handle numeric route keys", () => {
      const routes = {
        "404": "/not-found",
        "500": "/error",
      };

      const builder = createRouteMap().add(routes);

      expect(builder.routes["404"]).toBe("/not-found");
      expect(builder.routes["500"]).toBe("/error");
    });
  });

  describe("mixed prefix and non-prefix", () => {
    it("should handle mix of prefixed and non-prefixed routes", () => {
      const builder = createRouteMap()
        .add({ home: "/", notFound: "/404" }) // No prefix
        .add({ index: "/", post: "/:slug" }, "blog") // With prefix
        .add({ index: "/", product: "/:id" }, "shop"); // With prefix

      expect(builder.routes).toEqual({
        home: "/",
        notFound: "/404",
        "blog.index": "/blog",
        "blog.post": "/blog/:slug",
        "shop.index": "/shop",
        "shop.product": "/shop/:id",
      });
    });
  });
});

describe("registerRouteMap / getGlobalRouteMap", () => {
  beforeEach(() => {
    // Reset global state
    registerRouteMap({});
  });

  it("should register route map globally", () => {
    const routes = {
      home: "/",
      about: "/about",
    };

    registerRouteMap(routes);

    expect(getGlobalRouteMap()).toBe(routes);
  });

  it("should overwrite previous registration", () => {
    registerRouteMap({ old: "/old" });
    registerRouteMap({ new: "/new" });

    expect(getGlobalRouteMap()).toEqual({ new: "/new" });
    expect(getGlobalRouteMap()).not.toHaveProperty("old");
  });

  it("should work with createRouteMap builder", () => {
    const routeMap = createRouteMap()
      .add({ index: "/" })
      .add({ posts: "/posts" }, "blog");

    registerRouteMap(routeMap.routes);

    expect(getGlobalRouteMap()).toEqual({
      index: "/",
      "blog.posts": "/blog/posts",
    });
  });

  it("should return empty object before registration", () => {
    // After reset in beforeEach
    expect(getGlobalRouteMap()).toEqual({});
  });
});
