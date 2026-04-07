import { describe, it, expect } from "vitest";
import {
  compilePattern,
  extractStaticPrefix,
  findMatch,
  isLazyEvaluationNeeded,
} from "../router/pattern-matching.js";
import {
  parsePattern as parseMiddlewarePattern,
  extractParams,
  parseCookies,
  serializeCookie,
} from "../router/middleware.js";
import { createReverse } from "../reverse.js";
import type { RouteEntry, TrailingSlashMode } from "../types.js";

// Helper to create minimal RouteEntry for findMatch tests
function entry(
  prefix: string,
  routes: Record<string, string>,
  opts?: {
    staticPrefix?: string;
    trailingSlash?: Record<string, TrailingSlashMode>;
    lazy?: boolean;
    lazyEvaluated?: boolean;
  },
): RouteEntry {
  return {
    prefix,
    staticPrefix: opts?.staticPrefix ?? extractStaticPrefix(prefix),
    routes,
    trailingSlash: opts?.trailingSlash,
    handler: () => [],
    mountIndex: 0,
    lazy: opts?.lazy,
    lazyEvaluated: opts?.lazyEvaluated,
  } as RouteEntry;
}

// ========================================================================
// compilePattern
// ========================================================================

describe("compilePattern", () => {
  it("matches root path /", () => {
    const { regex } = compilePattern("/");
    expect(regex.test("/")).toBe(true);
    expect(regex.test("/anything")).toBe(false);
  });

  it("matches static paths", () => {
    const { regex } = compilePattern("/blog");
    expect(regex.test("/blog")).toBe(true);
    expect(regex.test("/blog/")).toBe(false);
    expect(regex.test("/blogs")).toBe(false);
  });

  it("matches nested static paths", () => {
    const { regex } = compilePattern("/admin/users");
    expect(regex.test("/admin/users")).toBe(true);
    expect(regex.test("/admin")).toBe(false);
  });

  it("matches dynamic params and extracts names", () => {
    const { regex, paramNames } = compilePattern("/blog/:slug");
    expect(paramNames).toEqual(["slug"]);
    const match = regex.exec("/blog/hello-world");
    expect(match?.[1]).toBe("hello-world");
  });

  it("matches multiple params", () => {
    const { regex, paramNames } = compilePattern("/user/:userId/post/:postId");
    expect(paramNames).toEqual(["userId", "postId"]);
    const match = regex.exec("/user/42/post/7");
    expect(match?.[1]).toBe("42");
    expect(match?.[2]).toBe("7");
  });

  it("matches optional params", () => {
    const { regex, paramNames, optionalParams } =
      compilePattern("/:locale?/blog");
    expect(paramNames).toEqual(["locale"]);
    expect(optionalParams.has("locale")).toBe(true);
    expect(regex.test("/blog")).toBe(true);
    expect(regex.test("/en/blog")).toBe(true);
  });

  it("matches constrained params", () => {
    const { regex } = compilePattern("/:locale(en|gb)/blog");
    expect(regex.test("/en/blog")).toBe(true);
    expect(regex.test("/gb/blog")).toBe(true);
    expect(regex.test("/fr/blog")).toBe(false);
  });

  it("matches optional + constrained params", () => {
    const { regex } = compilePattern("/:locale(en|gb)?/blog");
    expect(regex.test("/blog")).toBe(true);
    expect(regex.test("/en/blog")).toBe(true);
    expect(regex.test("/fr/blog")).toBe(false);
  });

  it("matches wildcard", () => {
    const { regex, paramNames } = compilePattern("/api/*");
    expect(paramNames).toEqual(["*"]);
    const match = regex.exec("/api/users/123/posts");
    expect(match?.[1]).toBe("users/123/posts");
  });

  it("detects trailing slash in pattern", () => {
    const withSlash = compilePattern("/blog/");
    expect(withSlash.hasTrailingSlash).toBe(true);

    const withoutSlash = compilePattern("/blog");
    expect(withoutSlash.hasTrailingSlash).toBe(false);
  });

  it("trailing slash root is not detected as trailing slash", () => {
    const root = compilePattern("/");
    expect(root.hasTrailingSlash).toBe(false);
  });
});

// ========================================================================
// extractStaticPrefix
// ========================================================================

describe("extractStaticPrefix", () => {
  it("returns empty for root path", () => {
    expect(extractStaticPrefix("/")).toBe("");
  });

  it("returns empty for empty string", () => {
    expect(extractStaticPrefix("")).toBe("");
  });

  it("returns full pattern when fully static", () => {
    expect(extractStaticPrefix("/api")).toBe("/api");
  });

  it("returns prefix before first param", () => {
    expect(extractStaticPrefix("/blog/:slug")).toBe("/blog");
  });

  it("returns empty when pattern starts with param", () => {
    expect(extractStaticPrefix("/:locale")).toBe("");
  });

  it("returns nested prefix before param", () => {
    expect(extractStaticPrefix("/admin/users/:id")).toBe("/admin/users");
  });

  it("returns prefix before wildcard", () => {
    expect(extractStaticPrefix("/api/*")).toBe("/api");
  });

  it("handles param at second segment", () => {
    expect(extractStaticPrefix("/site/:locale")).toBe("/site");
  });
});

// ========================================================================
// findMatch
// ========================================================================

describe("findMatch", () => {
  it("matches a simple static route", () => {
    const entries = [entry("/", { home: "/" })];
    const result = findMatch("/", entries);
    expect(result).not.toBeNull();
    expect(!isLazyEvaluationNeeded(result!) && result!.routeKey).toBe("home");
  });

  it("returns null when no route matches", () => {
    const entries = [entry("/", { home: "/" })];
    expect(findMatch("/nope", entries)).toBeNull();
  });

  it("matches route with prefix", () => {
    const entries = [entry("/blog", { index: "/", post: "/:slug" })];
    const result = findMatch("/blog", entries);
    expect(result).not.toBeNull();
    expect(!isLazyEvaluationNeeded(result!) && result!.routeKey).toBe("index");
  });

  it("matches route with params and extracts them", () => {
    const entries = [entry("/blog", { post: "/:slug" })];
    const result = findMatch("/blog/hello", entries);
    expect(result).not.toBeNull();
    if (result && !isLazyEvaluationNeeded(result)) {
      expect(result.params.slug).toBe("hello");
    }
  });

  it("short-circuits on static prefix mismatch", () => {
    const entries = [
      entry("/api", { users: "/users" }, { staticPrefix: "/api" }),
      entry("/blog", { index: "/" }, { staticPrefix: "/blog" }),
    ];
    // Should skip /api entry and match /blog
    const result = findMatch("/blog", entries);
    expect(result).not.toBeNull();
    if (result && !isLazyEvaluationNeeded(result)) {
      expect(result.routeKey).toBe("index");
    }
  });

  it("returns lazy evaluation needed for unevaluated lazy entry", () => {
    const entries = [
      entry(
        "/shop",
        {},
        { lazy: true, lazyEvaluated: false, staticPrefix: "/shop" },
      ),
    ];
    const result = findMatch("/shop/anything", entries);
    expect(result).not.toBeNull();
    expect(isLazyEvaluationNeeded(result!)).toBe(true);
  });

  it("does not return lazy for already evaluated entry", () => {
    const entries = [
      entry(
        "/shop",
        { index: "/" },
        { lazy: true, lazyEvaluated: true, staticPrefix: "/shop" },
      ),
    ];
    const result = findMatch("/shop", entries);
    expect(result).not.toBeNull();
    expect(isLazyEvaluationNeeded(result!)).toBe(false);
  });

  describe("trailing slash", () => {
    it("mode 'never' redirects when trailing slash present", () => {
      const entries = [
        entry("/", { about: "/about" }, { trailingSlash: { about: "never" } }),
      ];
      const result = findMatch("/about/", entries);
      expect(result).not.toBeNull();
      if (result && !isLazyEvaluationNeeded(result)) {
        expect(result.redirectTo).toBe("/about");
      }
    });

    it("mode 'always' redirects when trailing slash missing", () => {
      const entries = [
        entry(
          "/",
          { about: "/about/" },
          { trailingSlash: { about: "always" } },
        ),
      ];
      const result = findMatch("/about", entries);
      expect(result).not.toBeNull();
      if (result && !isLazyEvaluationNeeded(result)) {
        expect(result.redirectTo).toBe("/about/");
      }
    });

    it("mode 'ignore' matches both forms without redirect", () => {
      const entries = [
        entry("/", { about: "/about" }, { trailingSlash: { about: "ignore" } }),
      ];
      const withSlash = findMatch("/about/", entries);
      expect(withSlash).not.toBeNull();
      if (withSlash && !isLazyEvaluationNeeded(withSlash)) {
        expect(withSlash.redirectTo).toBeUndefined();
      }

      const withoutSlash = findMatch("/about", entries);
      expect(withoutSlash).not.toBeNull();
      if (withoutSlash && !isLazyEvaluationNeeded(withoutSlash)) {
        expect(withoutSlash.redirectTo).toBeUndefined();
      }
    });
  });
});

// ========================================================================
// isLazyEvaluationNeeded
// ========================================================================

describe("isLazyEvaluationNeeded", () => {
  it("returns true for lazy evaluation response", () => {
    expect(isLazyEvaluationNeeded({ lazyEntry: {} as any })).toBe(true);
  });

  it("returns false for normal match result", () => {
    expect(
      isLazyEvaluationNeeded({
        entry: {} as any,
        routeKey: "k",
        params: {},
        optionalParams: new Set(),
      }),
    ).toBe(false);
  });

  it("returns false for null", () => {
    expect(isLazyEvaluationNeeded(null)).toBe(false);
  });
});

// ========================================================================
// Middleware: parsePattern
// ========================================================================

describe("middleware parsePattern", () => {
  it("wildcard * matches everything", () => {
    const { regex } = parseMiddlewarePattern("*");
    expect(regex.test("/")).toBe(true);
    expect(regex.test("/any/thing")).toBe(true);
  });

  it("static path matches exactly and trailing", () => {
    const { regex } = parseMiddlewarePattern("/api");
    expect(regex.test("/api")).toBe(true);
    expect(regex.test("/api/")).toBe(true);
    expect(regex.test("/api/users")).toBe(false);
  });

  it("path with wildcard suffix matches subtree", () => {
    const { regex } = parseMiddlewarePattern("/api/*");
    expect(regex.test("/api")).toBe(true);
    expect(regex.test("/api/users")).toBe(true);
    expect(regex.test("/api/users/123")).toBe(true);
  });

  it("path with param extracts param names", () => {
    const { regex, paramNames } = parseMiddlewarePattern("/user/:id");
    expect(paramNames).toEqual(["id"]);
    expect(regex.test("/user/42")).toBe(true);
  });
});

// ========================================================================
// Middleware: extractParams
// ========================================================================

describe("extractParams", () => {
  it("extracts params from matched pathname", () => {
    const { regex, paramNames } = parseMiddlewarePattern("/user/:id");
    const params = extractParams("/user/42", regex, paramNames);
    expect(params).toEqual({ id: "42" });
  });

  it("returns empty object on no match", () => {
    const { regex, paramNames } = parseMiddlewarePattern("/user/:id");
    const params = extractParams("/nope", regex, paramNames);
    expect(params).toEqual({});
  });

  it("extracts multiple params", () => {
    const { regex, paramNames } = parseMiddlewarePattern(
      "/org/:orgId/team/:teamId",
    );
    const params = extractParams("/org/acme/team/eng", regex, paramNames);
    expect(params).toEqual({ orgId: "acme", teamId: "eng" });
  });
});

// ========================================================================
// Middleware: parseCookies
// ========================================================================

describe("parseCookies", () => {
  it("returns empty object for null", () => {
    expect(parseCookies(null)).toEqual({});
  });

  it("parses single cookie", () => {
    expect(parseCookies("theme=dark")).toEqual({ theme: "dark" });
  });

  it("parses multiple cookies", () => {
    const result = parseCookies("theme=dark; locale=en; session=abc123");
    expect(result).toEqual({ theme: "dark", locale: "en", session: "abc123" });
  });

  it("decodes URI-encoded values", () => {
    const result = parseCookies("data=hello%20world");
    expect(result.data).toBe("hello world");
  });

  it("handles value with = sign", () => {
    const result = parseCookies("token=abc=def=ghi");
    expect(result.token).toBe("abc=def=ghi");
  });
});

// ========================================================================
// Middleware: serializeCookie
// ========================================================================

describe("serializeCookie", () => {
  it("serializes name and value", () => {
    expect(serializeCookie("theme", "dark")).toBe("theme=dark");
  });

  it("URI-encodes name and value", () => {
    const result = serializeCookie("my key", "my value");
    expect(result).toBe("my%20key=my%20value");
  });

  it("includes all options", () => {
    const result = serializeCookie("session", "abc", {
      domain: "example.com",
      path: "/",
      maxAge: 3600,
      httpOnly: true,
      secure: true,
      sameSite: "strict",
    });
    expect(result).toContain("Domain=example.com");
    expect(result).toContain("Path=/");
    expect(result).toContain("Max-Age=3600");
    expect(result).toContain("HttpOnly");
    expect(result).toContain("Secure");
    expect(result).toContain("SameSite=strict");
  });

  it("includes Expires when set", () => {
    const date = new Date("2026-01-01T00:00:00Z");
    const result = serializeCookie("x", "y", { expires: date });
    expect(result).toContain("Expires=");
    expect(result).toContain("Thu, 01 Jan 2026");
  });

  it("omits options that are not set", () => {
    const result = serializeCookie("a", "b", { httpOnly: false });
    expect(result).not.toContain("HttpOnly");
    expect(result).not.toContain("Domain");
  });
});

// ========================================================================
// createReverse
// ========================================================================

describe("createReverse", () => {
  const routeMap = {
    home: "/",
    about: "/about",
    "blog.post": "/blog/:slug",
    "product.detail": "/product/:category/:id",
  };

  const reverse = createReverse(routeMap);

  it("returns static path for paramless route", () => {
    expect(reverse("home" as any)).toBe("/");
    expect(reverse("about" as any)).toBe("/about");
  });

  it("substitutes params into pattern", () => {
    expect(reverse("blog.post" as any, { slug: "hello" })).toBe("/blog/hello");
  });

  it("substitutes multiple params", () => {
    expect(
      reverse("product.detail" as any, { category: "shoes", id: "42" }),
    ).toBe("/product/shoes/42");
  });

  it("URI-encodes param values", () => {
    expect(reverse("blog.post" as any, { slug: "hello world" })).toBe(
      "/blog/hello%20world",
    );
  });

  it("throws for unknown route", () => {
    expect(() => reverse("nonexistent" as any)).toThrow(
      "Unknown route: nonexistent",
    );
  });

  it("throws for missing param", () => {
    expect(() => reverse("blog.post" as any, {} as any)).toThrow(
      'Missing param "slug"',
    );
  });

  it("substitutes constrained required param", () => {
    const r = createReverse({
      "i18n.blog": "/:locale(en|gb)/blog",
    });
    expect(r("i18n.blog" as any, { locale: "en" })).toBe("/en/blog");
    expect(r("i18n.blog" as any, { locale: "gb" })).toBe("/gb/blog");
  });

  it("substitutes constrained optional param when provided", () => {
    const r = createReverse({
      "i18n.blog": "/:locale(en|gb)?/blog",
    });
    expect(r("i18n.blog" as any, { locale: "gb" })).toBe("/gb/blog");
  });

  it("throws with stripped key name for missing constrained param", () => {
    const r = createReverse({
      "checkout.step": "/:step(shipping|payment)/checkout",
    });
    expect(() => r("checkout.step" as any, {} as any)).toThrow(
      'Missing param "step"',
    );
  });

  it("omits optional param segment when not provided", () => {
    const r = createReverse({
      "shop.category": "/category/:name/:page?",
    });
    expect(r("shop.category" as any, { name: "shoes" })).toBe(
      "/category/shoes",
    );
  });

  it("includes optional param when provided", () => {
    const r = createReverse({
      "shop.category": "/category/:name/:page?",
    });
    expect(r("shop.category" as any, { name: "shoes", page: "2" })).toBe(
      "/category/shoes/2",
    );
  });

  it("omits optional constrained param when not provided", () => {
    const r = createReverse({
      "i18n.blog": "/:locale(en|gb)?/blog",
    });
    expect(r("i18n.blog" as any, {})).toBe("/blog");
  });

  it("still throws for missing required param when optional params exist", () => {
    const r = createReverse({
      "shop.category": "/category/:name/:page?",
    });
    expect(() => r("shop.category" as any, {} as any)).toThrow(
      'Missing param "name"',
    );
  });

  it("preserves intentional trailing slash on non-optional patterns", () => {
    const r = createReverse({
      trailing: "/blog/",
    });
    expect(r("trailing" as any)).toBe("/blog/");
  });

  it("preserves trailing slash when optional param is omitted from slash-terminated pattern", () => {
    const r = createReverse({
      "i18n.blog": "/:locale(en|gb)?/blog/",
      "shop.category": "/category/:name/:page?/",
    });
    expect(r("i18n.blog" as any, {})).toBe("/blog/");
    expect(r("shop.category" as any, { name: "shoes" })).toBe(
      "/category/shoes/",
    );
  });
});

// ========================================================================
// resolveRouteName — tested through createHandlerContext's reverse()
// ========================================================================
describe("resolveRouteName (via createHandlerContext.reverse)", () => {
  // Import createHandlerContext to test resolveRouteName indirectly
  // We use a dynamic import since the module isn't imported at the top
  async function makeReverse(
    routeMap: Record<string, string>,
    currentRoute?: string,
    currentParams?: Record<string, string>,
  ) {
    const { createHandlerContext } =
      await import("../router/handler-context.js");
    const ctx = createHandlerContext(
      currentParams ?? {},
      new Request("http://localhost/"),
      new URLSearchParams(),
      "/",
      new URL("http://localhost/"),
      {},
      routeMap,
      currentRoute,
    );
    return ctx.reverse;
  }

  const routeMap: Record<string, string> = {
    "home.index": "/",
    "blog.index": "/blog",
    "blog.post": "/blog/:slug",
    "blog.author": "/blog/author/:authorSlug",
    "blog.author.posts": "/blog/author/:authorSlug/posts",
    "magazine.index": "/magazine",
    "magazine.article": "/magazine/:slug",
    "magazine.author": "/magazine/author/:authorSlug",
    "magazine.author.posts": "/magazine/author/:authorSlug/posts",
    "product.detail": "/product/:productId",
  };

  // Dot-prefixed = local resolution (within include() scope)
  it("should resolve dot-prefixed names locally", async () => {
    const reverse = await makeReverse(routeMap, "magazine.author");
    expect(reverse(".article" as any, { slug: "design" })).toBe(
      "/magazine/design",
    );
  });

  it("should resolve dot-prefixed dotted names locally", async () => {
    const reverse = await makeReverse(routeMap, "magazine.author");
    expect(reverse(".author.posts" as any, { authorSlug: "alice" })).toBe(
      "/magazine/author/alice/posts",
    );
  });

  it("should walk up parent prefixes for dot-prefixed names", async () => {
    const reverse = await makeReverse(routeMap, "magazine.author");
    expect(reverse(".index" as any)).toBe("/magazine");
  });

  it("should throw for dot-prefixed names that don't exist locally", async () => {
    const reverse = await makeReverse(routeMap, "magazine.author");
    expect(() => reverse(".blog.index" as any)).toThrow("Unknown route");
  });

  it("should throw for dot-prefixed names without a route context", async () => {
    const reverse = await makeReverse(routeMap);
    expect(() => reverse(".index" as any)).toThrow("Unknown route");
  });

  it("should resolve dot-local names through the hidden scope of an unnamed include", async () => {
    const reverse = await makeReverse(
      {
        "$prefix_0.index": "/admin",
        "$prefix_0.users": "/admin/users",
      },
      "$prefix_0.users",
    );

    expect(reverse(".index" as any)).toBe("/admin");
    expect(() => reverse("index" as any)).toThrow("Unknown route");
  });

  // Unprefixed = global resolution (named-routes definition)
  it("should resolve unprefixed names globally", async () => {
    const reverse = await makeReverse(routeMap, "magazine.author");
    expect(reverse("blog.author.posts" as any, { authorSlug: "jane" })).toBe(
      "/blog/author/jane/posts",
    );
  });

  it("should resolve fully-qualified global names", async () => {
    const reverse = await makeReverse(routeMap, "magazine.author");
    expect(reverse("magazine.index" as any)).toBe("/magazine");
  });

  it("should NOT resolve unprefixed local names (global only)", async () => {
    const reverse = await makeReverse(routeMap, "magazine.author");
    // "article" is a local name — without dot prefix, it's treated as global
    // and there's no global "article" key
    expect(() => reverse("article" as any, { slug: "design" })).toThrow(
      "Unknown route",
    );
  });

  it("should throw for unknown global names", async () => {
    const reverse = await makeReverse(routeMap, "magazine.author");
    expect(() => reverse("nonexistent.route" as any)).toThrow("Unknown route");
  });

  it("should throw for global names when required params cannot be auto-filled", async () => {
    const reverse = await makeReverse(routeMap, "magazine.author", {
      authorSlug: "alice",
    });
    expect(() => reverse("product.detail" as any)).toThrow(
      'Missing param "productId"',
    );
  });
});
