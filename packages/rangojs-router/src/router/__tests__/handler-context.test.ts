import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSearchSchemaMock, isRouteRootScopedMock } = vi.hoisted(() => ({
  getSearchSchemaMock: vi.fn(() => undefined),
  isRouteRootScopedMock: vi.fn((): boolean | undefined => undefined),
}));

// Mock dependencies before importing the module under test
vi.mock("../../server/request-context.js", () => ({
  getRequestContext: () => undefined,
  _getRequestContext: () => undefined,
}));

vi.mock("../../route-map-builder.js", () => ({
  getSearchSchema: getSearchSchemaMock,
  isRouteRootScoped: isRouteRootScopedMock,
}));

import {
  createHandlerContext,
  createPrerenderContext,
  createStaticContext,
  createReverseFunction,
  stripInternalParams,
} from "../handler-context";

beforeEach(() => {
  getSearchSchemaMock.mockReset();
  getSearchSchemaMock.mockReturnValue(undefined);
  isRouteRootScopedMock.mockReset();
  isRouteRootScopedMock.mockReturnValue(undefined);
});

/**
 * Helper to build a minimal HandlerContext for testing search param behavior.
 * Only the searchParams/url fields are relevant; other arguments use defaults.
 */
function buildContext(searchParams: URLSearchParams) {
  const url = new URL("http://localhost/test");
  url.search = searchParams.toString();

  return createHandlerContext(
    {}, // params
    new Request(url.href),
    searchParams,
    "/test",
    url,
  );
}

describe("createHandlerContext", () => {
  describe("search param pass-through", () => {
    it("should preserve multi-valued query params", () => {
      const params = new URLSearchParams("tag=a&tag=b&tag=c");
      const ctx = buildContext(params);

      const result = ctx.searchParams as URLSearchParams;
      expect(result.getAll("tag")).toEqual(["a", "b", "c"]);
    });

    it("should pass through params unchanged", () => {
      const params = new URLSearchParams("page=2&sort=name");
      const ctx = buildContext(params);

      const result = ctx.searchParams as URLSearchParams;
      expect(result.get("page")).toBe("2");
      expect(result.get("sort")).toBe("name");
    });

    it("should expose the same URL that was passed in", () => {
      const params = new URLSearchParams("q=test&page=1");
      const ctx = buildContext(params);

      expect(ctx.url.searchParams.get("q")).toBe("test");
      expect(ctx.url.searchParams.get("page")).toBe("1");
    });
  });

  describe("passthrough()", () => {
    it("throws at runtime even for passthrough prerender routes", () => {
      const url = new URL("http://localhost/guides/routing");
      const ctx = createHandlerContext(
        { slug: "routing" },
        new Request(url.href),
        url.searchParams,
        "/guides/routing",
        url,
        {},
        { "guides.detail": "/guides/:slug" },
        "guides.detail",
        undefined,
        true,
      );

      expect(() => (ctx as any).passthrough()).toThrow(
        "ctx.passthrough() can only be called during build-time prerendering.",
      );
    });
  });
});

describe("stripInternalParams", () => {
  it("should remove all _rsc-prefixed params", () => {
    const url = new URL(
      "http://localhost/test?q=hello&_rsc_partial=1&_rsc_segments=M0,M1&_rsc_v=abc&page=2",
    );
    const clean = stripInternalParams(url);

    expect(clean.searchParams.get("q")).toBe("hello");
    expect(clean.searchParams.get("page")).toBe("2");
    expect(clean.searchParams.has("_rsc_partial")).toBe(false);
    expect(clean.searchParams.has("_rsc_segments")).toBe(false);
    expect(clean.searchParams.has("_rsc_v")).toBe(false);
  });

  it("should return empty search when all params are internal", () => {
    const url = new URL("http://localhost/test?_rsc_partial=1&_rsc_stale=true");
    const clean = stripInternalParams(url);
    expect(clean.search).toBe("");
  });

  it("should preserve all user params when no internal params exist", () => {
    const url = new URL("http://localhost/test?q=hello&page=2");
    const clean = stripInternalParams(url);
    expect(clean.searchParams.get("q")).toBe("hello");
    expect(clean.searchParams.get("page")).toBe("2");
  });

  it("should not mutate the original URL", () => {
    const url = new URL("http://localhost/test?q=hello&_rsc_partial=1");
    stripInternalParams(url);
    expect(url.searchParams.has("_rsc_partial")).toBe(true);
  });

  it("should preserve pathname and origin", () => {
    const url = new URL(
      "http://example.com/path/to/page?_rsc_partial=1&q=test",
    );
    const clean = stripInternalParams(url);
    expect(clean.origin).toBe("http://example.com");
    expect(clean.pathname).toBe("/path/to/page");
    expect(clean.searchParams.get("q")).toBe("test");
  });

  it("should strip _rsc_loader transport params and preserve user search", () => {
    const url = new URL(
      "http://localhost/products?tab=pricing&_rsc_loader=myLoader&_rsc_loader_params=%7B%7D",
    );
    const clean = stripInternalParams(url);
    expect(clean.searchParams.get("tab")).toBe("pricing");
    expect(clean.searchParams.has("_rsc_loader")).toBe(false);
    expect(clean.searchParams.has("_rsc_loader_params")).toBe(false);
  });
});

describe("createHandlerContext routeName", () => {
  it("should set routeName for a named route", () => {
    const url = new URL("http://localhost/blog/hello");
    const ctx = createHandlerContext(
      { slug: "hello" },
      new Request(url.href),
      url.searchParams,
      "/blog/hello",
      url,
      {},
      { "blog.post": "/blog/:slug" },
      "blog.post",
    );
    expect(ctx.routeName).toBe("blog.post");
  });

  it("should set routeName to undefined for an unnamed route", () => {
    const url = new URL("http://localhost/health");
    const ctx = createHandlerContext(
      {},
      new Request(url.href),
      url.searchParams,
      "/health",
      url,
      {},
      {},
      "$path__health",
    );
    expect(ctx.routeName).toBeUndefined();
  });

  it("should set routeName to undefined for a namespaced unnamed route", () => {
    const url = new URL("http://localhost/docs/faq");
    const ctx = createHandlerContext(
      {},
      new Request(url.href),
      url.searchParams,
      "/docs/faq",
      url,
      {},
      {},
      "docs.$path__faq",
    );
    expect(ctx.routeName).toBeUndefined();
  });

  it("should set routeName to undefined for a route inside a hidden include scope", () => {
    const url = new URL("http://localhost/admin/users");
    const ctx = createHandlerContext(
      {},
      new Request(url.href),
      url.searchParams,
      "/admin/users",
      url,
      {},
      {},
      "$prefix_0.users",
    );
    expect(ctx.routeName).toBeUndefined();
  });

  it("should set routeName to undefined when no routeName is provided", () => {
    const url = new URL("http://localhost/test");
    const ctx = createHandlerContext(
      {},
      new Request(url.href),
      url.searchParams,
      "/test",
      url,
    );
    expect(ctx.routeName).toBeUndefined();
  });

  it("should include the full namespace prefix for named routes under include()", () => {
    const url = new URL("http://localhost/magazine/article/1");
    const ctx = createHandlerContext(
      { id: "1" },
      new Request(url.href),
      url.searchParams,
      "/magazine/article/1",
      url,
      {},
      { "magazine.article": "/magazine/article/:id" },
      "magazine.article",
    );
    expect(ctx.routeName).toBe("magazine.article");
  });

  it("captures rootScoped eagerly so same route names stay isolated across routers", () => {
    const url = new URL("http://localhost/flat/sub/42");
    const routeMap = {
      flatIndex: "/flat",
      "sub.detail": "/flat/sub/:id",
      "sub.index": "/flat/sub",
    };

    // Simulate two routers reusing the same route name with different scope
    // semantics. The first one is root-scoped (flattened mount), the second
    // one is not (named mount boundary).
    isRouteRootScopedMock.mockReturnValueOnce(true).mockReturnValueOnce(false);

    const rootScopedCtx = createHandlerContext(
      { id: "42" },
      new Request(url.href),
      url.searchParams,
      "/flat/sub/42",
      url,
      {},
      routeMap,
      "sub.detail",
    );
    const namedScopedCtx = createHandlerContext(
      { id: "42" },
      new Request(url.href),
      url.searchParams,
      "/flat/sub/42",
      url,
      {},
      routeMap,
      "sub.detail",
    );

    expect(isRouteRootScopedMock).toHaveBeenCalledTimes(2);

    // Changing the global registry afterward must not affect the already
    // constructed reverse functions.
    isRouteRootScopedMock.mockReturnValue(undefined);

    expect(rootScopedCtx.reverse(".flatIndex")).toBe("/flat");
    expect(() => namedScopedCtx.reverse(".flatIndex")).toThrow("Unknown route");
    expect(isRouteRootScopedMock).toHaveBeenCalledTimes(2);
  });
});

describe("createPrerenderContext routeName", () => {
  it("should set routeName for a named route", () => {
    const ctx = createPrerenderContext(
      { slug: "hello" },
      "/blog/hello",
      { "blog.post": "/blog/:slug" },
      "blog.post",
    );
    expect(ctx.routeName).toBe("blog.post");
  });

  it("should set routeName to undefined for an unnamed route", () => {
    const ctx = createPrerenderContext({}, "/health", {}, "$path__health");
    expect(ctx.routeName).toBeUndefined();
  });

  it("should set routeName to undefined when no routeName is provided", () => {
    const ctx = createPrerenderContext({}, "/test", {});
    expect(ctx.routeName).toBeUndefined();
  });
});

describe("createStaticContext routeName", () => {
  it("should set routeName for a named route", () => {
    const ctx = createStaticContext(
      { "blog.post": "/blog/:slug" },
      "blog.post",
    );
    expect(ctx.routeName).toBe("blog.post");
  });

  it("should set routeName to undefined for an unnamed route", () => {
    const ctx = createStaticContext({}, "$path__health");
    expect(ctx.routeName).toBeUndefined();
  });

  it("should set routeName to undefined when no routeName is provided", () => {
    const ctx = createStaticContext({});
    expect(ctx.routeName).toBeUndefined();
  });
});

describe("createReverseFunction", () => {
  // Simulates route map from include("/tenant/:tenantId", innerPatterns)
  // where innerPatterns has path("/", ...) and path("/settings", ...)
  const routeMap: Record<string, string> = {
    "tenant.index": "/tenant/:tenantId",
    "tenant.settings": "/tenant/:tenantId/settings",
    "tenant.user": "/tenant/:tenantId/users/:userId",
    about: "/about",
  };

  describe("reverse with auto-filled params", () => {
    it("should auto-fill mount params from currentParams", () => {
      const reverse = createReverseFunction(routeMap, "tenant.index", {
        tenantId: "acme",
      });
      expect(reverse(".settings")).toBe("/tenant/acme/settings");
    });

    it("should auto-fill params for local route back to index", () => {
      const reverse = createReverseFunction(routeMap, "tenant.settings", {
        tenantId: "acme",
      });
      expect(reverse(".index")).toBe("/tenant/acme");
    });

    it("should allow explicit params to override auto-filled params", () => {
      const reverse = createReverseFunction(routeMap, "tenant.index", {
        tenantId: "acme",
      });
      expect(reverse(".settings", { tenantId: "other" })).toBe(
        "/tenant/other/settings",
      );
    });

    it("should combine auto-filled mount params with explicit route params", () => {
      const reverse = createReverseFunction(routeMap, "tenant.index", {
        tenantId: "acme",
      });
      expect(reverse(".user", { userId: "u1" })).toBe("/tenant/acme/users/u1");
    });

    it("should use auto-filled params from a route with multiple params", () => {
      const reverse = createReverseFunction(routeMap, "tenant.user", {
        tenantId: "acme",
        userId: "u1",
      });
      // Reversing back to settings only needs tenantId, userId is extra (ignored)
      expect(reverse(".settings")).toBe("/tenant/acme/settings");
    });

    it("should auto-fill params for global (non-dot-prefixed) routes", () => {
      const reverse = createReverseFunction(routeMap, "tenant.index", {
        tenantId: "acme",
      });
      expect(reverse("tenant.settings")).toBe("/tenant/acme/settings");
    });

    it("should work for routes without params when currentParams are present", () => {
      const reverse = createReverseFunction(routeMap, "tenant.index", {
        tenantId: "acme",
      });
      // Extra params from currentParams are ignored since /about has no :param
      expect(reverse("about")).toBe("/about");
    });

    it("should return raw pattern when no currentParams and no hrefParams", () => {
      const reverse = createReverseFunction(routeMap, "tenant.index");
      // Without any params, substitution is skipped (existing behavior)
      expect(reverse(".settings")).toBe("/tenant/:tenantId/settings");
    });

    it("should throw when hrefParams provided but missing required param", () => {
      const reverse = createReverseFunction(routeMap, "tenant.index");
      // Passing an empty object triggers substitution, which then throws
      expect(() => reverse(".settings", {})).toThrow(
        'Missing param "tenantId"',
      );
    });

    it("should throw for missing params not covered by currentParams", () => {
      const reverse = createReverseFunction(routeMap, "tenant.index", {
        tenantId: "acme",
      });
      // .user needs userId which isn't in currentParams
      expect(() => reverse(".user")).toThrow('Missing param "userId"');
    });

    it("should encode unsafe chars in auto-filled param values", () => {
      const reverse = createReverseFunction(routeMap, "tenant.index", {
        tenantId: "hello world",
      });
      // Space must be encoded.
      expect(reverse(".settings")).toBe("/tenant/hello%20world/settings");
    });

    it("should keep path-legal chars readable in auto-filled params", () => {
      // @ is legal in a path segment; reverse must not over-encode it
      // (e.g. a mailbox ID used as a tenant key should stay human-readable
      // in the address bar).
      const reverse = createReverseFunction(routeMap, "tenant.index", {
        tenantId: "ivo@example.com",
      });
      expect(reverse(".settings")).toBe("/tenant/ivo@example.com/settings");
    });
  });

  describe('dot-local reverse with { name: "" } (root-scope fallback)', () => {
    // Simulates include("/flat", patterns, { name: "" })
    // Children are registered with bare names at root scope.
    const flatRouteMap: Record<string, string> = {
      flatIndex: "/flat",
      flatDetail: "/flat/:id",
      otherRoute: "/other",
    };

    it("should resolve dot-local name to root-scope sibling", () => {
      const reverse = createReverseFunction(flatRouteMap, "flatIndex");
      expect(reverse(".flatDetail", { id: "42" })).toBe("/flat/42");
    });

    it("should resolve dot-local back to index from sibling", () => {
      const reverse = createReverseFunction(flatRouteMap, "flatDetail", {
        id: "42",
      });
      expect(reverse(".flatIndex")).toBe("/flat");
    });

    it("should resolve dot-local to any root-scope route", () => {
      const reverse = createReverseFunction(flatRouteMap, "flatIndex");
      expect(reverse(".otherRoute")).toBe("/other");
    });

    it("should throw for unknown dot-local name at root scope", () => {
      const reverse = createReverseFunction(flatRouteMap, "flatIndex");
      expect(() => reverse(".nonExistent")).toThrow(
        'Unknown route: ".nonExistent"',
      );
    });
  });

  describe('dot-local reverse with { name: "" } + nested { name: "sub" }', () => {
    // Simulates include("/flat", patterns, { name: "" }) where patterns
    // contain a nested include("/sub", subPatterns, { name: "sub" }).
    // Routes from the nested include get dotted names (sub.detail, sub.index)
    // but are still at root scope because the outer include is { name: "" }.
    const flatWithNestedMap: Record<string, string> = {
      flatIndex: "/flat",
      "sub.detail": "/flat/sub/:id",
      "sub.index": "/flat/sub",
    };

    it("should resolve dot-local from dotted route to bare sibling at root", () => {
      // From sub.detail, .flatIndex should resolve — both are at root scope.
      // rootScoped=true because the outer include is { name: "" }.
      const reverse = createReverseFunction(
        flatWithNestedMap,
        "sub.detail",
        {},
        true,
      );
      expect(reverse(".flatIndex")).toBe("/flat");
    });

    it("should resolve dot-local from dotted route to dotted sibling", () => {
      // From sub.detail, .index resolves via prefixed lookup (sub.index)
      const reverse = createReverseFunction(flatWithNestedMap, "sub.detail");
      expect(reverse(".index")).toBe("/flat/sub");
    });

    it("should resolve dot-local from bare route to dotted sibling", () => {
      // From flatIndex, .sub.detail resolves via root fallback
      const reverse = createReverseFunction(
        flatWithNestedMap,
        "flatIndex",
        {},
        true,
      );
      expect(reverse(".sub.detail", { id: "42" })).toBe("/flat/sub/42");
    });

    it("should NOT resolve cross-scope from a named mount", () => {
      // Same route map, but rootScoped=false (simulates { name: "magazine" })
      const reverse = createReverseFunction(
        flatWithNestedMap,
        "sub.detail",
        {},
        false,
      );
      expect(() => reverse(".flatIndex")).toThrow("Unknown route");
    });
  });

  describe("optional params", () => {
    const optionalMap: Record<string, string> = {
      "shop.category": "/category/:name/:page?",
      "i18n.blog": "/:locale(en|gb)?/blog",
      trailing: "/blog/",
    };

    it("omits optional param when not provided", () => {
      const reverse = createReverseFunction(optionalMap, "shop.category");
      expect(reverse("shop.category", { name: "shoes" })).toBe(
        "/category/shoes",
      );
    });

    it("includes optional param when provided", () => {
      const reverse = createReverseFunction(optionalMap, "shop.category");
      expect(reverse("shop.category", { name: "shoes", page: "2" })).toBe(
        "/category/shoes/2",
      );
    });

    it("omits optional constrained param when not provided", () => {
      const reverse = createReverseFunction(optionalMap, "i18n.blog");
      expect(reverse("i18n.blog", {})).toBe("/blog");
    });

    it("throws for missing required param when optional params exist", () => {
      const reverse = createReverseFunction(optionalMap, "shop.category");
      expect(() => reverse("shop.category", {})).toThrow(
        'Missing param "name"',
      );
    });

    it("preserves intentional trailing slash on non-optional patterns", () => {
      const reverse = createReverseFunction(optionalMap, "trailing");
      expect(reverse("trailing")).toBe("/blog/");
    });

    it("preserves trailing slash when optional param is omitted from slash-terminated pattern", () => {
      const trailingOptMap: Record<string, string> = {
        "i18n.blog": "/:locale(en|gb)?/blog/",
        "shop.category": "/category/:name/:page?/",
      };
      const r1 = createReverseFunction(trailingOptMap, "i18n.blog");
      expect(r1("i18n.blog", {})).toBe("/blog/");

      const r2 = createReverseFunction(trailingOptMap, "shop.category");
      expect(r2("shop.category", { name: "shoes" })).toBe("/category/shoes/");
    });
  });
});
