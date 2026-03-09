import { describe, it, expect, vi } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("../../server/request-context.js", () => ({
  getRequestContext: () => undefined,
  _getRequestContext: () => undefined,
}));

vi.mock("../../route-map-builder.js", () => ({
  getSearchSchema: () => undefined,
}));

import {
  createHandlerContext,
  createPrerenderContext,
  createStaticContext,
  createReverseFunction,
  stripInternalParams,
} from "../handler-context";

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

    it("should URL-encode auto-filled param values", () => {
      const reverse = createReverseFunction(routeMap, "tenant.index", {
        tenantId: "hello world",
      });
      expect(reverse(".settings")).toBe("/tenant/hello%20world/settings");
    });
  });
});
