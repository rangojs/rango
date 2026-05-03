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

  describe("suffix params", () => {
    it("should match param with inline suffix (.html)", () => {
      const { regex, paramNames } = compilePattern("/shop/:productId.html");
      expect(regex.test("/shop/widget.html")).toBe(true);
      expect(regex.test("/shop/123.html")).toBe(true);
      expect(regex.test("/shop/electronics")).toBe(false);
      expect(regex.test("/shop/.html")).toBe(false);
      expect(paramNames).toEqual(["productId"]);
    });

    it("should capture only the param portion, not the suffix", () => {
      const { regex } = compilePattern("/shop/:productId.html");
      const match = regex.exec("/shop/widget.html");
      expect(match).not.toBeNull();
      expect(match![1]).toBe("widget");
    });

    it("should handle multi-dot values before suffix", () => {
      const { regex } = compilePattern("/shop/:productId.html");
      const match = regex.exec("/shop/widget.v2.html");
      expect(match).not.toBeNull();
      expect(match![1]).toBe("widget.v2");
    });

    it("should match param with .json suffix", () => {
      const { regex, paramNames } = compilePattern("/api/:resource.json");
      expect(regex.test("/api/users.json")).toBe(true);
      expect(regex.test("/api/users")).toBe(false);
      expect(paramNames).toEqual(["resource"]);

      const match = regex.exec("/api/users.json");
      expect(match![1]).toBe("users");
    });

    it("should match suffix param followed by more segments", () => {
      const { regex, paramNames } = compilePattern("/files/:name.txt/meta");
      expect(regex.test("/files/readme.txt/meta")).toBe(true);
      expect(regex.test("/files/readme/meta")).toBe(false);
      expect(paramNames).toEqual(["name"]);

      const match = regex.exec("/files/readme.txt/meta");
      expect(match![1]).toBe("readme");
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

    it("should extract suffix param correctly", () => {
      const entries = [
        createRouteEntry("", {
          "shop.product": "/shop/:productId.html",
          "shop.category": "/shop/:categoryId",
        }),
      ];

      // .html URL matches the suffix route with correct param
      const product = findMatch("/shop/widget.html", entries);
      expect(product).not.toBeNull();
      expect(product!.routeKey).toBe("shop.product");
      expect(product!.params).toEqual({ productId: "widget" });

      // plain URL matches the plain param route
      const category = findMatch("/shop/electronics", entries);
      expect(category).not.toBeNull();
      expect(category!.routeKey).toBe("shop.category");
      expect(category!.params).toEqual({ categoryId: "electronics" });
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

    it("omits absent optional params from `params` (key not present)", () => {
      const entries = [createRouteEntry("", { blog: "/:locale?/blog" })];
      const result = findMatch("/blog", entries);
      expect(result).not.toBeNull();
      expect(result!.params).toEqual({});
      expect(result!.params.locale).toBeUndefined();
      expect(result!.optionalParams.has("locale")).toBe(true);
    });

    it("should handle multiple optional params correctly", () => {
      const entries = [
        createRouteEntry("", { shop: "/:locale?/:region?/shop" }),
      ];

      expect(findMatch("/shop", entries)!.params).toEqual({});
      expect(findMatch("/en/shop", entries)!.params).toEqual({ locale: "en" });
      expect(findMatch("/en/us/shop", entries)!.params).toEqual({
        locale: "en",
        region: "us",
      });
    });

    it("trailing-slash fallback also omits absent optional params (regression)", () => {
      // `/blog/` doesn't exact-match the no-trailing-slash pattern, so the
      // matcher tries the alternate pathname (`/blog`). The alternate-match
      // branch must apply the same skip-undefined contract — historically it
      // coalesced absent groups to `""` while the exact-match branch did not.
      const entries = [createRouteEntry("", { blog: "/:locale?/blog" })];
      const result = findMatch("/blog/", entries);
      expect(result).not.toBeNull();
      expect(result!.params).toEqual({});
      expect(result!.params.locale).toBeUndefined();
      expect(result!.redirectTo).toBe("/blog");
    });
  });

  // Patterns made entirely of optional segments (no static suffix) must accept
  // a bare `/` as the "absent" form. This shape arises naturally when
  // `include("/:locale?", routes)` is composed with an inner `path("/")`:
  // the joined pattern collapses to `/:locale?`, and without this guarantee
  // the index route 404s for non-localized requests.
  describe("all-optional patterns (no static tail)", () => {
    it("/:locale? matches `/` and `/en`, but not `/en/`", () => {
      const { regex, paramNames, optionalParams } = compilePattern("/:locale?");
      expect(paramNames).toEqual(["locale"]);
      expect(optionalParams.has("locale")).toBe(true);
      expect(regex.test("/")).toBe(true);
      expect(regex.test("/en")).toBe(true);
      expect(regex.test("/en/")).toBe(false);
      expect(regex.test("/en/extra")).toBe(false);
    });

    it("/:locale(en|gb)? matches `/`, `/en`, `/gb`", () => {
      const { regex, constraints } = compilePattern("/:locale(en|gb)?");
      expect(constraints).toEqual({ locale: ["en", "gb"] });
      expect(regex.test("/")).toBe(true);
      expect(regex.test("/en")).toBe(true);
      expect(regex.test("/gb")).toBe(true);
      // Constraint validation lives in findMatch, not the regex — `/fr` still
      // matches the regex but is rejected post-decode (covered below).
    });

    it("/:a?/:b? matches `/`, `/a`, `/a/b`", () => {
      const { regex } = compilePattern("/:a?/:b?");
      expect(regex.test("/")).toBe(true);
      expect(regex.test("/a")).toBe(true);
      expect(regex.test("/a/b")).toBe(true);
      expect(regex.test("/a/b/c")).toBe(false);
    });

    it("findMatch on bare `/` through an optional include prefix", () => {
      // Mirrors the include('/:locale?', routes) + path('/', Home) shape.
      // Fixture: include's `prefix` becomes the entry prefix; the inner '/'
      // pattern collapses via the joiner so the effective pattern is
      // entry.prefix itself.
      const entries = [createRouteEntry("/:locale?", { home: "/" })];

      const root = findMatch("/", entries);
      expect(root).not.toBeNull();
      expect(root!.params).toEqual({ locale: "" });
      expect(root!.optionalParams.has("locale")).toBe(true);

      const localized = findMatch("/en", entries);
      expect(localized).not.toBeNull();
      expect(localized!.params).toEqual({ locale: "en" });
    });

    it("findMatch on a child route through an optional include prefix", () => {
      // Pin the case the bug report flagged as also-broken so we lock in
      // the diagnosis: child routes under an optional include prefix must
      // match both with and without the leading optional segment.
      const entries = [createRouteEntry("/:locale?", { category: "/c/:slug" })];

      expect(findMatch("/c/breads", entries)!.params).toEqual({
        locale: "",
        slug: "breads",
      });
      expect(findMatch("/en/c/breads", entries)!.params).toEqual({
        locale: "en",
        slug: "breads",
      });
    });

    it("findMatch on a constrained optional include prefix rejects unknown locales", () => {
      const entries = [createRouteEntry("/:locale(en|gb)?", { home: "/" })];

      expect(findMatch("/", entries)!.params).toEqual({ locale: "" });
      expect(findMatch("/en", entries)!.params).toEqual({ locale: "en" });
      expect(findMatch("/gb", entries)!.params).toEqual({ locale: "gb" });
      expect(findMatch("/fr", entries)).toBeNull(); // constraint rejection
    });
  });

  // Trailing-slash interactions for the all-optional shape. The compiler-level
  // fix above guards `!hasTrailingSlash` so a pattern with an explicit
  // trailing slash compiles to the same regex it always did. These tests
  // pin that contract and the findMatch redirect/accept behavior across the
  // three trailing-slash modes when the optional segment is the entire join.
  describe("all-optional patterns + trailing slash", () => {
    it("compilePattern('/:locale?/') matches `/` and `/en/`, NOT `/en`", () => {
      const { regex, hasTrailingSlash } = compilePattern("/:locale?/");
      expect(hasTrailingSlash).toBe(true);
      expect(regex.test("/")).toBe(true);
      expect(regex.test("/en/")).toBe(true);
      expect(regex.test("/en")).toBe(false);
    });

    it("compilePattern('/:locale(en|gb)?/') matches `/`, `/en/`, `/gb/`", () => {
      const { regex } = compilePattern("/:locale(en|gb)?/");
      expect(regex.test("/")).toBe(true);
      expect(regex.test("/en/")).toBe(true);
      expect(regex.test("/gb/")).toBe(true);
      expect(regex.test("/en")).toBe(false);
    });

    it("trailingSlash 'ignore' on root-via-include accepts `/` and `/en/` without redirect", () => {
      const entries = [
        createRouteEntry("/:locale?", { home: "/" }, { home: "ignore" }),
      ];

      const root = findMatch("/", entries);
      expect(root).not.toBeNull();
      expect(root!.params).toEqual({ locale: "" });
      expect(root!.redirectTo).toBeUndefined();

      const localizedSlash = findMatch("/en/", entries);
      expect(localizedSlash).not.toBeNull();
      expect(localizedSlash!.params).toEqual({ locale: "en" });
      expect(localizedSlash!.redirectTo).toBeUndefined();

      const localizedNoSlash = findMatch("/en", entries);
      expect(localizedNoSlash).not.toBeNull();
      expect(localizedNoSlash!.params).toEqual({ locale: "en" });
      expect(localizedNoSlash!.redirectTo).toBeUndefined();
    });

    it("trailingSlash 'never' on root-via-include redirects `/en/` → `/en`, leaves `/` alone", () => {
      const entries = [
        createRouteEntry("/:locale?", { home: "/" }, { home: "never" }),
      ];

      const root = findMatch("/", entries);
      expect(root).not.toBeNull();
      expect(root!.params).toEqual({ locale: "" });
      expect(root!.redirectTo).toBeUndefined(); // `/` is already canonical

      const localizedSlash = findMatch("/en/", entries);
      expect(localizedSlash).not.toBeNull();
      expect(localizedSlash!.params).toEqual({ locale: "en" });
      expect(localizedSlash!.redirectTo).toBe("/en");
    });

    it("trailingSlash 'always' on root-via-include redirects `/en` → `/en/`, leaves `/` alone", () => {
      const entries = [
        createRouteEntry("/:locale?", { home: "/" }, { home: "always" }),
      ];

      const root = findMatch("/", entries);
      expect(root).not.toBeNull();
      expect(root!.params).toEqual({ locale: "" });
      expect(root!.redirectTo).toBeUndefined(); // `/` is its own canonical form

      const localizedNoSlash = findMatch("/en", entries);
      expect(localizedNoSlash).not.toBeNull();
      expect(localizedNoSlash!.params).toEqual({ locale: "en" });
      expect(localizedNoSlash!.redirectTo).toBe("/en/");
    });
  });
});

describe("constrained parameters", () => {
  describe("compilePattern", () => {
    // Constraint values are captured by compilePattern and surfaced on the
    // `constraints` field; findMatch validates them post-decode so that a
    // constraint like `:lang(en GB)` still matches a URL-encoded value like
    // `/en%20GB`. (Matching behavior is covered in "findMatch param
    // extraction" below; these tests just pin the compile-step contract.)
    it("should capture constraint list and param name", () => {
      const { paramNames, constraints } = compilePattern(
        "/:locale(en|gb)/blog",
      );
      expect(paramNames).toEqual(["locale"]);
      expect(constraints).toEqual({ locale: ["en", "gb"] });
    });

    it("should capture constraint for optional + constrained params", () => {
      const { paramNames, optionalParams, constraints } = compilePattern(
        "/:locale(en|gb)?/blog",
      );
      expect(paramNames).toEqual(["locale"]);
      expect(optionalParams.has("locale")).toBe(true);
      expect(constraints).toEqual({ locale: ["en", "gb"] });
    });

    it("should preserve regex metacharacters verbatim in constraint list", () => {
      const { constraints } = compilePattern("/:version(v1.0|v2.0)");
      // Values stored as-is; no regex-escaping leaks into the stored list.
      expect(constraints).toEqual({ version: ["v1.0", "v2.0"] });
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

    it("omits absent optional + constrained param from params", () => {
      const entries = [createRouteEntry("", { blog: "/:locale(en|gb)?/blog" })];
      const result = findMatch("/blog", entries);
      expect(result).not.toBeNull();
      expect(result!.params).toEqual({});
      expect(result!.params.locale).toBeUndefined();
      expect(result!.optionalParams.has("locale")).toBe(true);
    });

    it("should match constraint with regex metacharacters literally", () => {
      const entries = [
        createRouteEntry("", { versioned: "/:version(v1.0|v2.0)/docs" }),
      ];
      expect(findMatch("/v1.0/docs", entries)).not.toBeNull();
      expect(findMatch("/v2.0/docs", entries)).not.toBeNull();
      expect(findMatch("/v1.0/docs", entries)!.params).toEqual({
        version: "v1.0",
      });
    });

    it("should reject values where dots would match as regex wildcards", () => {
      const entries = [
        createRouteEntry("", { versioned: "/:version(v1.0|v2.0)/docs" }),
      ];
      expect(findMatch("/v1x0/docs", entries)).toBeNull();
      expect(findMatch("/v2X0/docs", entries)).toBeNull();
    });

    it("should reject invalid constraint value even when captured by regex", () => {
      const entries = [
        createRouteEntry("", { localized: "/:locale(en|gb)/blog" }),
      ];
      // Regression: now that constrained params capture [^/]+ (and are
      // validated post-decode), make sure the post-decode check still
      // rejects values outside the allowed list.
      expect(findMatch("/de/blog", entries)).toBeNull();
      expect(findMatch("/us/blog", entries)).toBeNull();
    });

    it("should match constraint value that was URL-encoded in the pathname", () => {
      // Parity with the trie path: `:lang(en US)` must match `/en%20US/foo`
      // because the constraint list contains the decoded value.
      const entries = [
        createRouteEntry("", { localized: "/:lang(en US|en GB)/foo" }),
      ];
      const encoded = findMatch("/en%20US/foo", entries);
      expect(encoded).not.toBeNull();
      expect(encoded!.params).toEqual({ lang: "en US" });

      const decoded = findMatch("/en US/foo", entries);
      expect(decoded).not.toBeNull();
      expect(decoded!.params).toEqual({ lang: "en US" });

      // Value outside the constraint list still rejected.
      expect(findMatch("/en%20CA/foo", entries)).toBeNull();
    });

    it("should fall through to a later route when an earlier constraint rejects", () => {
      // Fall-through is the same whether rejection comes from regex miss
      // or from post-decode constraint failure.
      const entries = [
        createRouteEntry("", {
          localized: "/:locale(en|gb)/blog",
          catchAll: "/:any/blog",
        }),
      ];
      const result = findMatch("/de/blog", entries);
      expect(result).not.toBeNull();
      expect(result!.routeKey).toBe("catchAll");
      expect(result!.params).toEqual({ any: "de" });
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
