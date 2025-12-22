import { describe, it, expect } from "vitest";
import { compilePattern, findMatch } from "../pattern-matching";
import type { RouteEntry } from "../../types";

describe("compilePattern", () => {
  describe("static patterns", () => {
    it("should match exact static path", () => {
      const { regex, paramNames } = compilePattern("/");
      expect(regex.test("/")).toBe(true);
      expect(regex.test("/foo")).toBe(false);
      expect(paramNames).toEqual([]);
    });

    it("should match static path with segments", () => {
      const { regex, paramNames } = compilePattern("/about");
      expect(regex.test("/about")).toBe(true);
      expect(regex.test("/")).toBe(false);
      expect(regex.test("/about/foo")).toBe(false);
      expect(paramNames).toEqual([]);
    });

    it("should match nested static path", () => {
      const { regex, paramNames } = compilePattern("/blog/posts");
      expect(regex.test("/blog/posts")).toBe(true);
      expect(regex.test("/blog")).toBe(false);
      expect(regex.test("/blog/posts/1")).toBe(false);
      expect(paramNames).toEqual([]);
    });
  });

  describe("dynamic parameters", () => {
    it("should match single param", () => {
      const { regex, paramNames } = compilePattern("/:id");
      expect(regex.test("/123")).toBe(true);
      expect(regex.test("/abc")).toBe(true);
      expect(regex.test("/")).toBe(false);
      expect(regex.test("/123/456")).toBe(false);
      expect(paramNames).toEqual(["id"]);
    });

    it("should capture param value", () => {
      const { regex, paramNames } = compilePattern("/:slug");
      const match = regex.exec("/hello-world");
      expect(match).not.toBeNull();
      expect(match![1]).toBe("hello-world");
      expect(paramNames).toEqual(["slug"]);
    });

    it("should match param with prefix", () => {
      const { regex, paramNames } = compilePattern("/blog/:slug");
      expect(regex.test("/blog/my-post")).toBe(true);
      expect(regex.test("/blog/")).toBe(false);
      expect(regex.test("/blog")).toBe(false);
      expect(paramNames).toEqual(["slug"]);
    });

    it("should match param with suffix", () => {
      const { regex, paramNames } = compilePattern("/:id/edit");
      expect(regex.test("/123/edit")).toBe(true);
      expect(regex.test("/123")).toBe(false);
      expect(regex.test("/123/view")).toBe(false);
      expect(paramNames).toEqual(["id"]);
    });

    it("should match multiple params", () => {
      const { regex, paramNames } = compilePattern("/blog/:slug/comments/:commentId");
      expect(regex.test("/blog/my-post/comments/42")).toBe(true);
      expect(regex.test("/blog/my-post/comments")).toBe(false);
      expect(paramNames).toEqual(["slug", "commentId"]);

      const match = regex.exec("/blog/my-post/comments/42");
      expect(match![1]).toBe("my-post");
      expect(match![2]).toBe("42");
    });

    it("should match consecutive params", () => {
      const { regex, paramNames } = compilePattern("/:category/:id");
      expect(regex.test("/electronics/123")).toBe(true);
      expect(regex.test("/electronics")).toBe(false);
      expect(paramNames).toEqual(["category", "id"]);
    });
  });

  describe("wildcard patterns", () => {
    it("should match catch-all wildcard", () => {
      const { regex, paramNames } = compilePattern("/*");
      expect(regex.test("/")).toBe(true);
      expect(regex.test("/foo")).toBe(true);
      expect(regex.test("/foo/bar/baz")).toBe(true);
      expect(paramNames).toEqual(["*"]);
    });

    it("should capture wildcard value", () => {
      const { regex } = compilePattern("/files/*");
      const match = regex.exec("/files/docs/readme.md");
      expect(match).not.toBeNull();
      expect(match![1]).toBe("docs/readme.md");
    });

    it("should match wildcard with prefix", () => {
      const { regex, paramNames } = compilePattern("/api/*");
      expect(regex.test("/api/users")).toBe(true);
      expect(regex.test("/api/users/123/posts")).toBe(true);
      expect(regex.test("/api/")).toBe(true);
      expect(regex.test("/api")).toBe(false);
      expect(paramNames).toEqual(["*"]);
    });
  });
});

describe("findMatch", () => {
  const createRouteEntry = (
    prefix: string,
    routes: Record<string, string>
  ): RouteEntry => ({
    prefix,
    routes: routes as any,
    handler: () => [],
    mountIndex: 0,
  });

  describe("basic matching", () => {
    it("should match root route", () => {
      const entries = [createRouteEntry("", { index: "/" })];
      const result = findMatch("/", entries);
      expect(result).not.toBeNull();
      expect(result!.routeKey).toBe("index");
      expect(result!.params).toEqual({});
    });

    it("should match static route", () => {
      const entries = [
        createRouteEntry("", {
          index: "/",
          about: "/about",
          contact: "/contact",
        }),
      ];

      const result = findMatch("/about", entries);
      expect(result).not.toBeNull();
      expect(result!.routeKey).toBe("about");
    });

    it("should return null for no match", () => {
      const entries = [createRouteEntry("", { index: "/" })];
      const result = findMatch("/not-found", entries);
      expect(result).toBeNull();
    });
  });

  describe("parameter extraction", () => {
    it("should extract single param", () => {
      const entries = [
        createRouteEntry("", {
          "products.detail": "/product/:slug",
        }),
      ];

      const result = findMatch("/product/my-product", entries);
      expect(result).not.toBeNull();
      expect(result!.routeKey).toBe("products.detail");
      expect(result!.params).toEqual({ slug: "my-product" });
    });

    it("should extract multiple params", () => {
      const entries = [
        createRouteEntry("", {
          "products.reviews.detail": "/product/:slug/reviews/:reviewId",
        }),
      ];

      const result = findMatch("/product/my-product/reviews/42", entries);
      expect(result).not.toBeNull();
      expect(result!.params).toEqual({ slug: "my-product", reviewId: "42" });
    });
  });

  describe("prefix handling", () => {
    it("should match with prefix", () => {
      const entries = [
        createRouteEntry("/admin", {
          dashboard: "/dashboard",
          users: "/users",
        }),
      ];

      const result = findMatch("/admin/dashboard", entries);
      expect(result).not.toBeNull();
      expect(result!.routeKey).toBe("dashboard");
    });

    it("should match prefix root", () => {
      const entries = [
        createRouteEntry("/shop", {
          index: "/",
        }),
      ];

      const result = findMatch("/shop", entries);
      expect(result).not.toBeNull();
      expect(result!.routeKey).toBe("index");
    });

    it("should handle empty prefix", () => {
      const entries = [
        createRouteEntry("", {
          index: "/",
          about: "/about",
        }),
      ];

      expect(findMatch("/", entries)!.routeKey).toBe("index");
      expect(findMatch("/about", entries)!.routeKey).toBe("about");
    });

    it("should handle slash prefix", () => {
      const entries = [
        createRouteEntry("/", {
          index: "/",
          about: "/about",
        }),
      ];

      expect(findMatch("/", entries)!.routeKey).toBe("index");
      expect(findMatch("/about", entries)!.routeKey).toBe("about");
    });
  });

  describe("multiple route entries", () => {
    it("should match first matching entry", () => {
      const entries = [
        createRouteEntry("/api", { users: "/users" }),
        createRouteEntry("", { home: "/" }),
      ];

      expect(findMatch("/api/users", entries)!.routeKey).toBe("users");
      expect(findMatch("/", entries)!.routeKey).toBe("home");
    });

    it("should check entries in order", () => {
      const entries = [
        createRouteEntry("", { specific: "/blog/featured" }),
        createRouteEntry("", { dynamic: "/blog/:slug" }),
      ];

      const result = findMatch("/blog/featured", entries);
      expect(result!.routeKey).toBe("specific");
    });
  });
});

describe("optional parameters (future)", () => {
  it.todo("should match pattern with optional param present: /:locale?/blog -> /en/blog");
  it.todo("should match pattern with optional param absent: /:locale?/blog -> /blog");
  it.todo("should extract optional param when present");
  it.todo("should return undefined for optional param when absent");
  it.todo("should handle multiple optional params");
  it.todo("should handle optional param at end: /blog/:page?");
  it.todo("should handle mix of required and optional params");
});
