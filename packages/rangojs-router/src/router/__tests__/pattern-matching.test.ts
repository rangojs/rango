import { describe, it, expect, beforeEach } from "vitest";
import {
  compilePattern,
  extractStaticPrefix,
  findMatch as rawFindMatch,
  isLazyEvaluationNeeded,
  getPatternCacheSize,
  clearPatternCache,
  type RouteMatchResult,
} from "../pattern-matching";
import type { RouteEntry, TrailingSlashMode } from "../../types";

// Wrapper for findMatch that asserts it's not a lazy evaluation result
// All tests in this file use non-lazy entries, so this is safe
function findMatch<TEnv>(
  ...args: Parameters<typeof rawFindMatch<TEnv>>
): RouteMatchResult<TEnv> | null {
  const result = rawFindMatch(...args);
  if (result === null) return null;
  if (isLazyEvaluationNeeded(result)) {
    throw new Error("Unexpected lazy evaluation needed");
  }
  return result;
}

// Helper to create route entries for testing
const createRouteEntry = (
  prefix: string,
  routes: Record<string, string>,
  trailingSlash?: Record<string, TrailingSlashMode>,
): RouteEntry => ({
  prefix,
  staticPrefix: extractStaticPrefix(prefix),
  routes: routes as any,
  trailingSlash,
  handler: () => [],
  mountIndex: 0,
});

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
      const { regex, paramNames } = compilePattern(
        "/blog/:slug/comments/:commentId",
      );
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

describe("optional parameters", () => {
  describe("compilePattern", () => {
    it("should match pattern with optional param present: /:locale?/blog -> /en/blog", () => {
      const { regex, paramNames, optionalParams } =
        compilePattern("/:locale?/blog");
      expect(regex.test("/en/blog")).toBe(true);
      expect(paramNames).toEqual(["locale"]);
      expect(optionalParams.has("locale")).toBe(true);
    });

    it("should match pattern with optional param absent: /:locale?/blog -> /blog", () => {
      const { regex } = compilePattern("/:locale?/blog");
      expect(regex.test("/blog")).toBe(true);
    });

    it("should not match invalid paths for optional patterns", () => {
      const { regex } = compilePattern("/:locale?/blog");
      expect(regex.test("/en/gb/blog")).toBe(false);
      expect(regex.test("/en/other")).toBe(false);
    });

    it("should handle optional param at end: /blog/:page?", () => {
      const { regex, paramNames, optionalParams } =
        compilePattern("/blog/:page?");
      expect(regex.test("/blog")).toBe(true);
      expect(regex.test("/blog/2")).toBe(true);
      expect(regex.test("/blog/")).toBe(false);
      expect(paramNames).toEqual(["page"]);
      expect(optionalParams.has("page")).toBe(true);
    });

    it("should handle multiple optional params", () => {
      const { regex } = compilePattern("/:locale?/:region?/shop");
      expect(regex.test("/shop")).toBe(true);
      expect(regex.test("/en/shop")).toBe(true);
      expect(regex.test("/en/us/shop")).toBe(true);
    });

    it("should handle mix of required and optional params", () => {
      const { regex, paramNames, optionalParams } = compilePattern(
        "/:locale?/blog/:slug",
      );
      expect(regex.test("/blog/hello")).toBe(true);
      expect(regex.test("/en/blog/hello")).toBe(true);
      expect(regex.test("/blog")).toBe(false);
      expect(paramNames).toEqual(["locale", "slug"]);
      expect(optionalParams.has("locale")).toBe(true);
      expect(optionalParams.has("slug")).toBe(false);
    });
  });

  describe("findMatch param extraction", () => {
    it("should extract optional param when present", () => {
      const entries = [createRouteEntry("", { blog: "/:locale?/blog" })];
      const result = findMatch("/en/blog", entries);
      expect(result).not.toBeNull();
      expect(result!.params).toEqual({ locale: "en" });
      expect(result!.optionalParams.has("locale")).toBe(true);
    });

    it("should return empty string for optional param when absent", () => {
      const entries = [createRouteEntry("", { blog: "/:locale?/blog" })];
      const result = findMatch("/blog", entries);
      expect(result).not.toBeNull();
      expect(result!.params).toEqual({ locale: "" });
      expect(result!.optionalParams.has("locale")).toBe(true);
    });

    it("should handle multiple optional params correctly", () => {
      const entries = [
        createRouteEntry("", { shop: "/:locale?/:region?/shop" }),
      ];

      expect(findMatch("/shop", entries)!.params).toEqual({
        locale: "",
        region: "",
      });
      expect(findMatch("/en/shop", entries)!.params).toEqual({
        locale: "en",
        region: "",
      });
      expect(findMatch("/en/us/shop", entries)!.params).toEqual({
        locale: "en",
        region: "us",
      });
    });
  });
});

describe("constrained parameters", () => {
  describe("compilePattern", () => {
    it("should match constrained param with valid value", () => {
      const { regex, paramNames } = compilePattern("/:locale(en|gb)/blog");
      expect(regex.test("/en/blog")).toBe(true);
      expect(regex.test("/gb/blog")).toBe(true);
      expect(paramNames).toEqual(["locale"]);
    });

    it("should not match constrained param with invalid value", () => {
      const { regex } = compilePattern("/:locale(en|gb)/blog");
      expect(regex.test("/de/blog")).toBe(false);
      expect(regex.test("/us/blog")).toBe(false);
    });

    it("should handle optional + constrained params", () => {
      const { regex, optionalParams } = compilePattern("/:locale(en|gb)?/blog");
      expect(regex.test("/blog")).toBe(true);
      expect(regex.test("/en/blog")).toBe(true);
      expect(regex.test("/gb/blog")).toBe(true);
      expect(regex.test("/de/blog")).toBe(false);
      expect(optionalParams.has("locale")).toBe(true);
    });

    it("should handle multiple constrained values", () => {
      const { regex } = compilePattern("/:type(post|page|comment)/edit");
      expect(regex.test("/post/edit")).toBe(true);
      expect(regex.test("/page/edit")).toBe(true);
      expect(regex.test("/comment/edit")).toBe(true);
      expect(regex.test("/user/edit")).toBe(false);
    });

    it("should escape regex metacharacters in constraint values", () => {
      const { regex } = compilePattern("/:version(v1.0|v2.0)");
      expect(regex.test("/v1.0")).toBe(true);
      expect(regex.test("/v2.0")).toBe(true);
      expect(regex.test("/v1x0")).toBe(false);
      expect(regex.test("/v2X0")).toBe(false);
    });

    it("should escape plus and hash in constraint values", () => {
      const { regex } = compilePattern("/:lang(c++|c#)");
      expect(regex.test("/c++")).toBe(true);
      expect(regex.test("/c#")).toBe(true);
      expect(regex.test("/cxx")).toBe(false);
    });

    it("should escape metacharacters in optional constrained params", () => {
      const { regex } = compilePattern("/:version(v1.0|v2.0)?/docs");
      expect(regex.test("/v1.0/docs")).toBe(true);
      expect(regex.test("/docs")).toBe(true);
      expect(regex.test("/v1x0/docs")).toBe(false);
    });
  });

  describe("findMatch param extraction", () => {
    it("should extract constrained param value", () => {
      const entries = [
        createRouteEntry("", { localized: "/:locale(en|gb)/blog" }),
      ];
      const result = findMatch("/en/blog", entries);
      expect(result).not.toBeNull();
      expect(result!.params).toEqual({ locale: "en" });
    });

    it("should extract optional + constrained param when present", () => {
      const entries = [createRouteEntry("", { blog: "/:locale(en|gb)?/blog" })];
      const result = findMatch("/gb/blog", entries);
      expect(result).not.toBeNull();
      expect(result!.params).toEqual({ locale: "gb" });
      expect(result!.optionalParams.has("locale")).toBe(true);
    });

    it("should return empty string for optional + constrained param when absent", () => {
      const entries = [createRouteEntry("", { blog: "/:locale(en|gb)?/blog" })];
      const result = findMatch("/blog", entries);
      expect(result).not.toBeNull();
      expect(result!.params).toEqual({ locale: "" });
      expect(result!.optionalParams.has("locale")).toBe(true);
    });
  });
});

describe("trailing slash handling", () => {
  describe("trailingSlash: ignore", () => {
    it("should match without trailing slash, no redirect", () => {
      const entries = [
        createRouteEntry("", { api: "/api" }, { api: "ignore" }),
      ];
      const result = findMatch("/api", entries);
      expect(result).not.toBeNull();
      expect(result!.routeKey).toBe("api");
      expect(result!.redirectTo).toBeUndefined();
    });

    it("should match with trailing slash, no redirect", () => {
      const entries = [
        createRouteEntry("", { api: "/api" }, { api: "ignore" }),
      ];
      const result = findMatch("/api/", entries);
      expect(result).not.toBeNull();
      expect(result!.routeKey).toBe("api");
      expect(result!.redirectTo).toBeUndefined();
    });

    it("should work with dynamic params", () => {
      const entries = [
        createRouteEntry(
          "",
          { product: "/product/:id" },
          { product: "ignore" },
        ),
      ];

      const withoutSlash = findMatch("/product/123", entries);
      expect(withoutSlash).not.toBeNull();
      expect(withoutSlash!.params).toEqual({ id: "123" });
      expect(withoutSlash!.redirectTo).toBeUndefined();

      const withSlash = findMatch("/product/123/", entries);
      expect(withSlash).not.toBeNull();
      expect(withSlash!.params).toEqual({ id: "123" });
      expect(withSlash!.redirectTo).toBeUndefined();
    });
  });

  describe("trailingSlash: never", () => {
    it("should match without trailing slash, no redirect", () => {
      const entries = [
        createRouteEntry("", { blog: "/blog" }, { blog: "never" }),
      ];
      const result = findMatch("/blog", entries);
      expect(result).not.toBeNull();
      expect(result!.routeKey).toBe("blog");
      expect(result!.redirectTo).toBeUndefined();
    });

    it("should match with trailing slash and redirect to without", () => {
      const entries = [
        createRouteEntry("", { blog: "/blog" }, { blog: "never" }),
      ];
      const result = findMatch("/blog/", entries);
      expect(result).not.toBeNull();
      expect(result!.routeKey).toBe("blog");
      expect(result!.redirectTo).toBe("/blog");
    });

    it("should redirect dynamic routes to no trailing slash", () => {
      const entries = [
        createRouteEntry("", { post: "/blog/:slug" }, { post: "never" }),
      ];
      const result = findMatch("/blog/hello-world/", entries);
      expect(result).not.toBeNull();
      expect(result!.params).toEqual({ slug: "hello-world" });
      expect(result!.redirectTo).toBe("/blog/hello-world");
    });
  });

  describe("trailingSlash: always", () => {
    it("should match with trailing slash, no redirect", () => {
      const entries = [
        createRouteEntry("", { docs: "/docs" }, { docs: "always" }),
      ];
      const result = findMatch("/docs/", entries);
      expect(result).not.toBeNull();
      expect(result!.routeKey).toBe("docs");
      expect(result!.redirectTo).toBeUndefined();
    });

    it("should match without trailing slash and redirect to with", () => {
      const entries = [
        createRouteEntry("", { docs: "/docs" }, { docs: "always" }),
      ];
      const result = findMatch("/docs", entries);
      expect(result).not.toBeNull();
      expect(result!.routeKey).toBe("docs");
      expect(result!.redirectTo).toBe("/docs/");
    });

    it("should redirect dynamic routes to with trailing slash", () => {
      const entries = [
        createRouteEntry(
          "",
          { category: "/shop/:cat" },
          { category: "always" },
        ),
      ];
      const result = findMatch("/shop/electronics", entries);
      expect(result).not.toBeNull();
      expect(result!.params).toEqual({ cat: "electronics" });
      expect(result!.redirectTo).toBe("/shop/electronics/");
    });
  });

  describe("pattern-based fallback (no explicit config)", () => {
    it("should redirect trailing slash to no trailing slash by default", () => {
      const entries = [
        createRouteEntry("", { about: "/about" }), // no trailingSlash config
      ];
      const result = findMatch("/about/", entries);
      expect(result).not.toBeNull();
      expect(result!.routeKey).toBe("about");
      expect(result!.redirectTo).toBe("/about");
    });

    it("should match exact pattern without redirect", () => {
      const entries = [createRouteEntry("", { about: "/about" })];
      const result = findMatch("/about", entries);
      expect(result).not.toBeNull();
      expect(result!.redirectTo).toBeUndefined();
    });
  });

  describe("root path handling", () => {
    it("should match root path without redirect", () => {
      const entries = [createRouteEntry("", { index: "/" })];
      const result = findMatch("/", entries);
      expect(result).not.toBeNull();
      expect(result!.routeKey).toBe("index");
      expect(result!.redirectTo).toBeUndefined();
    });
  });

  describe("mixed routes with different configs", () => {
    it("should apply correct config per route", () => {
      const entries = [
        createRouteEntry(
          "",
          {
            api: "/api",
            blog: "/blog",
            docs: "/docs",
          },
          {
            api: "ignore",
            blog: "never",
            docs: "always",
          },
        ),
      ];

      // api: ignore - both work, no redirect
      expect(findMatch("/api", entries)!.redirectTo).toBeUndefined();
      expect(findMatch("/api/", entries)!.redirectTo).toBeUndefined();

      // blog: never - redirect trailing to no trailing
      expect(findMatch("/blog", entries)!.redirectTo).toBeUndefined();
      expect(findMatch("/blog/", entries)!.redirectTo).toBe("/blog");

      // docs: always - redirect no trailing to trailing
      expect(findMatch("/docs/", entries)!.redirectTo).toBeUndefined();
      expect(findMatch("/docs", entries)!.redirectTo).toBe("/docs/");
    });
  });

  describe("lazy entries", () => {
    it("should return lazy evaluation needed when staticPrefix matches unevaluated lazy entry", () => {
      const entries: RouteEntry[] = [
        createRouteEntry("", { home: "/" }),
        {
          prefix: "",
          staticPrefix: "/api",
          routes: {} as any, // Empty - not evaluated yet
          handler: () => [],
          mountIndex: 1,
          lazy: true,
          lazyEvaluated: false,
        },
      ];

      // Regular route should still match
      expect(findMatch("/", entries)!.routeKey).toBe("home");

      // Lazy entry should return lazy evaluation needed
      const result = rawFindMatch("/api/users", entries);
      expect(result).not.toBeNull();
      expect(isLazyEvaluationNeeded(result!)).toBe(true);
      expect((result as any).lazyEntry.staticPrefix).toBe("/api");
    });

    it("should skip lazy entries when staticPrefix does not match", () => {
      const entries: RouteEntry[] = [
        createRouteEntry("", { home: "/" }),
        {
          prefix: "",
          staticPrefix: "/api",
          routes: {} as any,
          handler: () => [],
          mountIndex: 1,
          lazy: true,
          lazyEvaluated: false,
        },
        createRouteEntry("", { about: "/about" }),
      ];

      // Should skip lazy entry and find about
      expect(findMatch("/about", entries)!.routeKey).toBe("about");
    });

    it("should match normally when lazy entry has been evaluated", () => {
      const entries: RouteEntry[] = [
        {
          prefix: "",
          staticPrefix: "/api",
          routes: { users: "/api/users" } as any,
          handler: () => [],
          mountIndex: 0,
          lazy: true,
          lazyEvaluated: true, // Already evaluated
        },
      ];

      // Should match normally since entry has been evaluated
      const result = findMatch("/api/users", entries);
      expect(result).not.toBeNull();
      expect(result!.routeKey).toBe("users");
    });
  });
});

describe("compilePattern cache", () => {
  beforeEach(() => {
    clearPatternCache();
  });

  it("should cache compiled patterns across findMatch calls", () => {
    const entries = [
      createRouteEntry("", {
        index: "/",
        about: "/about",
        "blog.detail": "/blog/:slug",
      }),
    ];

    // First call: match a path that forces iteration through all routes
    // (no-match path causes findMatch to compile every pattern)
    findMatch("/no-match", entries);
    const sizeAfterFirst = getPatternCacheSize();
    // All three patterns should be compiled: /, /about, /blog/:slug
    expect(sizeAfterFirst).toBe(3);

    // Second call with same routes should not increase cache size
    findMatch("/about", entries);
    expect(getPatternCacheSize()).toBe(sizeAfterFirst);

    // Matching a different path against the same routes should not grow cache
    findMatch("/blog/hello", entries);
    expect(getPatternCacheSize()).toBe(sizeAfterFirst);
  });

  it("should return correct matches after being served from cache", () => {
    const entries = [
      createRouteEntry("", {
        about: "/about",
        "blog.detail": "/blog/:slug",
      }),
    ];

    // First call compiles and caches
    const first = findMatch("/blog/post-1", entries);
    expect(first).not.toBeNull();
    expect(first!.params).toEqual({ slug: "post-1" });

    // Second call uses cached pattern, should still produce correct params
    const second = findMatch("/blog/post-2", entries);
    expect(second).not.toBeNull();
    expect(second!.params).toEqual({ slug: "post-2" });
  });

  it("should cache patterns with prefixes correctly", () => {
    const entries = [
      createRouteEntry("/api", { users: "/users", health: "/health" }),
      createRouteEntry("", { index: "/" }),
    ];

    findMatch("/api/users", entries);
    const size = getPatternCacheSize();

    // Repeat the same match; cache should not grow
    findMatch("/api/users", entries);
    expect(getPatternCacheSize()).toBe(size);
  });

  it("clearPatternCache should reset the cache", () => {
    const entries = [createRouteEntry("", { about: "/about" })];
    findMatch("/about", entries);
    expect(getPatternCacheSize()).toBeGreaterThan(0);

    clearPatternCache();
    expect(getPatternCacheSize()).toBe(0);
  });
});
