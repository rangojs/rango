import { describe, it, expect } from "vitest";
import { createHandlerContext } from "../handler-context";

describe("createHandlerContext", () => {
  describe("basic context creation", () => {
    it("should create context with provided params", () => {
      const ctx = createHandlerContext(
        { slug: "test-product", id: "123" },
        new Request("http://localhost/products/test-product"),
        new URLSearchParams("tab=details"),
        "/products/test-product",
        new URL("http://localhost/products/test-product?tab=details")
      );

      expect(ctx.params).toEqual({ slug: "test-product", id: "123" });
    });

    it("should expose pathname", () => {
      const ctx = createHandlerContext(
        {},
        new Request("http://localhost/shop/cart"),
        new URLSearchParams(),
        "/shop/cart",
        new URL("http://localhost/shop/cart")
      );

      expect(ctx.pathname).toBe("/shop/cart");
    });

    it("should expose clean URL without system params", () => {
      const ctx = createHandlerContext(
        {},
        new Request("http://localhost/products?tab=details&_rsc=abc123"),
        new URLSearchParams("tab=details&_rsc=abc123"),
        "/products",
        new URL("http://localhost/products?tab=details&_rsc=abc123")
      );

      expect(ctx.url.toString()).toBe("http://localhost/products?tab=details");
      expect(ctx.url.searchParams.has("_rsc")).toBe(false);
      expect(ctx.url.searchParams.get("tab")).toBe("details");
    });
  });

  describe("system parameter filtering", () => {
    it("should filter _rsc params from searchParams", () => {
      const ctx = createHandlerContext(
        {},
        new Request("http://localhost/?_rsc=123&page=1"),
        new URLSearchParams("_rsc=123&page=1"),
        "/",
        new URL("http://localhost/?_rsc=123&page=1")
      );

      expect(ctx.searchParams.get("_rsc")).toBeNull();
      expect(ctx.searchParams.get("page")).toBe("1");
    });

    it("should filter _rsc_partial param", () => {
      const ctx = createHandlerContext(
        {},
        new Request("http://localhost/?_rsc_partial=true&sort=name"),
        new URLSearchParams("_rsc_partial=true&sort=name"),
        "/",
        new URL("http://localhost/?_rsc_partial=true&sort=name")
      );

      expect(ctx.searchParams.has("_rsc_partial")).toBe(false);
      expect(ctx.searchParams.get("sort")).toBe("name");
    });

    it("should filter _rsc_segments param", () => {
      const ctx = createHandlerContext(
        {},
        new Request("http://localhost/?_rsc_segments=L0,L1&filter=active"),
        new URLSearchParams("_rsc_segments=L0,L1&filter=active"),
        "/",
        new URL("http://localhost/?_rsc_segments=L0,L1&filter=active")
      );

      expect(ctx.searchParams.has("_rsc_segments")).toBe(false);
      expect(ctx.searchParams.get("filter")).toBe("active");
    });

    it("should filter all _rsc prefixed params", () => {
      const ctx = createHandlerContext(
        {},
        new Request("http://localhost/?_rsc_foo=1&_rsc_bar=2&user=john"),
        new URLSearchParams("_rsc_foo=1&_rsc_bar=2&user=john"),
        "/",
        new URL("http://localhost/?_rsc_foo=1&_rsc_bar=2&user=john")
      );

      expect(ctx.searchParams.has("_rsc_foo")).toBe(false);
      expect(ctx.searchParams.has("_rsc_bar")).toBe(false);
      expect(ctx.searchParams.get("user")).toBe("john");
    });

    it("should preserve non-system params that start with underscore", () => {
      const ctx = createHandlerContext(
        {},
        new Request("http://localhost/?_custom=value&_rsc=filtered"),
        new URLSearchParams("_custom=value&_rsc=filtered"),
        "/",
        new URL("http://localhost/?_custom=value&_rsc=filtered")
      );

      expect(ctx.searchParams.get("_custom")).toBe("value");
      expect(ctx.searchParams.has("_rsc")).toBe(false);
    });
  });

  describe("original request preservation", () => {
    it("should preserve original request with all params", () => {
      const originalRequest = new Request(
        "http://localhost/?_rsc=123&page=1"
      );
      const ctx = createHandlerContext(
        {},
        originalRequest,
        new URLSearchParams("_rsc=123&page=1"),
        "/",
        new URL("http://localhost/?_rsc=123&page=1")
      );

      expect(ctx._originalRequest).toBe(originalRequest);
    });
  });

  describe("variables (var) and get/set", () => {
    it("should start with empty variables", () => {
      const ctx = createHandlerContext(
        {},
        new Request("http://localhost/"),
        new URLSearchParams(),
        "/",
        new URL("http://localhost/")
      );

      expect(ctx.var).toEqual({});
    });

    it("should set and get variables", () => {
      const ctx = createHandlerContext(
        {},
        new Request("http://localhost/"),
        new URLSearchParams(),
        "/",
        new URL("http://localhost/")
      );

      ctx.set("user", { id: "123", name: "John" });
      expect(ctx.get("user")).toEqual({ id: "123", name: "John" });
    });

    it("should reflect set values in var object", () => {
      const ctx = createHandlerContext(
        {},
        new Request("http://localhost/"),
        new URLSearchParams(),
        "/",
        new URL("http://localhost/")
      );

      ctx.set("permissions", ["read", "write"]);
      expect(ctx.var.permissions).toEqual(["read", "write"]);
    });

    it("should return undefined for unset keys", () => {
      const ctx = createHandlerContext(
        {},
        new Request("http://localhost/"),
        new URLSearchParams(),
        "/",
        new URL("http://localhost/")
      );

      expect(ctx.get("nonexistent")).toBeUndefined();
    });

    it("should allow overwriting variables", () => {
      const ctx = createHandlerContext(
        {},
        new Request("http://localhost/"),
        new URLSearchParams(),
        "/",
        new URL("http://localhost/")
      );

      ctx.set("counter", 1);
      expect(ctx.get("counter")).toBe(1);

      ctx.set("counter", 2);
      expect(ctx.get("counter")).toBe(2);
    });
  });

  describe("bindings (env)", () => {
    it("should expose bindings through env", () => {
      const bindings = {
        DB: { query: () => {} },
        KV: { get: () => {}, put: () => {} },
        API_KEY: "secret-key",
      };

      const ctx = createHandlerContext(
        {},
        new Request("http://localhost/"),
        new URLSearchParams(),
        "/",
        new URL("http://localhost/"),
        bindings
      );

      expect(ctx.env).toBe(bindings);
      expect(ctx.env.API_KEY).toBe("secret-key");
    });

    it("should default to empty object when no bindings provided", () => {
      const ctx = createHandlerContext(
        {},
        new Request("http://localhost/"),
        new URLSearchParams(),
        "/",
        new URL("http://localhost/")
      );

      expect(ctx.env).toEqual({});
    });
  });

  describe("use() placeholder", () => {
    it("should throw error when use() called before initialization", () => {
      const ctx = createHandlerContext(
        {},
        new Request("http://localhost/"),
        new URLSearchParams(),
        "/",
        new URL("http://localhost/")
      );

      expect(() => ctx.use({} as any)).toThrow(
        "ctx.use() called before loaders were initialized"
      );
    });
  });

  describe("complex scenarios", () => {
    it("should handle multiple query params correctly", () => {
      const ctx = createHandlerContext(
        { category: "electronics" },
        new Request(
          "http://localhost/products?sort=price&order=asc&_rsc=123&page=2"
        ),
        new URLSearchParams("sort=price&order=asc&_rsc=123&page=2"),
        "/products",
        new URL("http://localhost/products?sort=price&order=asc&_rsc=123&page=2")
      );

      expect(ctx.searchParams.get("sort")).toBe("price");
      expect(ctx.searchParams.get("order")).toBe("asc");
      expect(ctx.searchParams.get("page")).toBe("2");
      expect(ctx.searchParams.has("_rsc")).toBe(false);
      expect(Array.from(ctx.searchParams.keys())).toHaveLength(3);
    });

    it("should handle URL with hash (fragment)", () => {
      const url = new URL("http://localhost/docs#section-1");
      const ctx = createHandlerContext(
        {},
        new Request(url),
        new URLSearchParams(),
        "/docs",
        url
      );

      expect(ctx.pathname).toBe("/docs");
      expect(ctx.url.hash).toBe("#section-1");
    });

    it("should handle encoded URL params", () => {
      const ctx = createHandlerContext(
        { search: "hello world" },
        new Request("http://localhost/search?q=hello%20world"),
        new URLSearchParams("q=hello%20world"),
        "/search",
        new URL("http://localhost/search?q=hello%20world")
      );

      expect(ctx.searchParams.get("q")).toBe("hello world");
      expect(ctx.params.search).toBe("hello world");
    });
  });
});
