/**
 * Tests for the standalone cookies() and headers() APIs (cookie-store.ts).
 *
 * These test the public CookieStore facade that delegates to RequestContext.
 * Read-after-write, mutation guards, and cross-phase visibility are covered.
 */
import { describe, it, expect } from "vitest";
import {
  createRequestContext,
  runWithRequestContext,
  getRequestContext,
} from "../request-context.js";
import { cookies, headers } from "../cookie-store.js";
import { INSIDE_CACHE_EXEC } from "../../cache/taint.js";

/** Helper: create a RequestContext and run `fn` inside it. */
function withContext(
  opts: { cookieHeader?: string; headers?: Record<string, string> },
  fn: () => void,
) {
  const hdrs: Record<string, string> = { ...opts.headers };
  if (opts.cookieHeader) hdrs["Cookie"] = opts.cookieHeader;

  const ctx = createRequestContext({
    env: {},
    request: new Request("https://example.com", { headers: hdrs }),
    url: new URL("https://example.com"),
    variables: {},
  });

  runWithRequestContext(ctx, fn);
}

describe("cookies()", () => {
  describe("get()", () => {
    it("returns a Cookie object for an existing request cookie", () => {
      withContext({ cookieHeader: "session=abc123; lang=en" }, () => {
        const c = cookies().get("session");
        expect(c).toEqual({ name: "session", value: "abc123" });
      });
    });

    it("returns undefined for a missing cookie", () => {
      withContext({ cookieHeader: "a=1" }, () => {
        expect(cookies().get("missing")).toBeUndefined();
      });
    });

    it("returns undefined when no cookies exist", () => {
      withContext({}, () => {
        expect(cookies().get("anything")).toBeUndefined();
      });
    });
  });

  describe("getAll()", () => {
    it("returns all cookies as Cookie[]", () => {
      withContext({ cookieHeader: "a=1; b=2; c=3" }, () => {
        const all = cookies().getAll();
        expect(all).toEqual(
          expect.arrayContaining([
            { name: "a", value: "1" },
            { name: "b", value: "2" },
            { name: "c", value: "3" },
          ]),
        );
        expect(all).toHaveLength(3);
      });
    });

    it("filters by name when provided", () => {
      withContext({ cookieHeader: "a=1; b=2" }, () => {
        expect(cookies().getAll("a")).toEqual([{ name: "a", value: "1" }]);
        expect(cookies().getAll("missing")).toEqual([]);
      });
    });

    it("returns empty array when no cookies exist", () => {
      withContext({}, () => {
        expect(cookies().getAll()).toEqual([]);
      });
    });
  });

  describe("has()", () => {
    it("returns true for existing cookie", () => {
      withContext({ cookieHeader: "token=xyz" }, () => {
        expect(cookies().has("token")).toBe(true);
      });
    });

    it("returns false for missing cookie", () => {
      withContext({ cookieHeader: "token=xyz" }, () => {
        expect(cookies().has("other")).toBe(false);
      });
    });
  });

  describe("set()", () => {
    it("appends Set-Cookie to response stub", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com"),
        url: new URL("https://example.com"),
        variables: {},
      });

      runWithRequestContext(ctx, () => {
        cookies().set("token", "abc", { httpOnly: true, path: "/" });
      });

      const setCookieHeaders = ctx.res.headers.getSetCookie();
      expect(setCookieHeaders.length).toBe(1);
      expect(setCookieHeaders[0]).toContain("token=abc");
      expect(setCookieHeaders[0]).toContain("HttpOnly");
    });

    it("supports multiple set() calls", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com"),
        url: new URL("https://example.com"),
        variables: {},
      });

      runWithRequestContext(ctx, () => {
        cookies().set("a", "1");
        cookies().set("b", "2");
      });

      const setCookieHeaders = ctx.res.headers.getSetCookie();
      expect(setCookieHeaders.length).toBe(2);
    });
  });

  describe("delete()", () => {
    it("appends Set-Cookie with max-age=0 to response stub", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com", {
          headers: { Cookie: "session=abc" },
        }),
        url: new URL("https://example.com"),
        variables: {},
      });

      runWithRequestContext(ctx, () => {
        cookies().delete("session");
      });

      const setCookieHeaders = ctx.res.headers.getSetCookie();
      expect(setCookieHeaders.length).toBe(1);
      expect(setCookieHeaders[0]).toContain("session=");
      expect(setCookieHeaders[0]).toMatch(/[Mm]ax-[Aa]ge=0/);
    });

    it("supports domain and path options", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com", {
          headers: { Cookie: "session=abc" },
        }),
        url: new URL("https://example.com"),
        variables: {},
      });

      runWithRequestContext(ctx, () => {
        cookies().delete("session", { domain: "example.com", path: "/" });
      });

      const setCookieHeaders = ctx.res.headers.getSetCookie();
      expect(setCookieHeaders[0]).toContain("Domain=example.com");
      expect(setCookieHeaders[0]).toContain("Path=/");
    });
  });

  describe("read-after-write", () => {
    it("set() makes get() return the new value", () => {
      withContext({ cookieHeader: "token=old" }, () => {
        expect(cookies().get("token")?.value).toBe("old");
        cookies().set("token", "new");
        expect(cookies().get("token")?.value).toBe("new");
      });
    });

    it("set() makes has() return true for new cookie", () => {
      withContext({}, () => {
        expect(cookies().has("fresh")).toBe(false);
        cookies().set("fresh", "value");
        expect(cookies().has("fresh")).toBe(true);
      });
    });

    it("set() makes getAll() include the new cookie", () => {
      withContext({ cookieHeader: "a=1" }, () => {
        cookies().set("b", "2");
        const all = cookies().getAll();
        expect(all).toEqual(
          expect.arrayContaining([
            { name: "a", value: "1" },
            { name: "b", value: "2" },
          ]),
        );
      });
    });

    it("delete() makes get() return undefined", () => {
      withContext({ cookieHeader: "session=abc" }, () => {
        expect(cookies().get("session")?.value).toBe("abc");
        cookies().delete("session");
        expect(cookies().get("session")).toBeUndefined();
      });
    });

    it("delete() makes has() return false", () => {
      withContext({ cookieHeader: "session=abc" }, () => {
        expect(cookies().has("session")).toBe(true);
        cookies().delete("session");
        expect(cookies().has("session")).toBe(false);
      });
    });

    it("delete() removes from getAll()", () => {
      withContext({ cookieHeader: "a=1; b=2" }, () => {
        cookies().delete("a");
        const all = cookies().getAll();
        expect(all).toEqual([{ name: "b", value: "2" }]);
      });
    });

    it("last-write-wins for multiple set() on same name", () => {
      withContext({}, () => {
        cookies().set("x", "first");
        cookies().set("x", "second");
        cookies().set("x", "third");
        expect(cookies().get("x")?.value).toBe("third");
      });
    });

    it("set() then delete() makes cookie undefined", () => {
      withContext({}, () => {
        cookies().set("temp", "value");
        expect(cookies().get("temp")?.value).toBe("value");
        cookies().delete("temp");
        expect(cookies().get("temp")).toBeUndefined();
      });
    });
  });

  describe("cross-phase visibility", () => {
    it("cookies set via RequestContext are visible via cookies()", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com"),
        url: new URL("https://example.com"),
        variables: {},
      });

      // Simulate action setting a cookie directly on RequestContext
      ctx.setCookie("action-token", "abc");

      runWithRequestContext(ctx, () => {
        // Simulated render phase reading via cookies()
        expect(cookies().get("action-token")?.value).toBe("abc");
        expect(cookies().has("action-token")).toBe(true);
      });
    });

    it("cookies set via cookies() are visible via RequestContext", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com"),
        url: new URL("https://example.com"),
        variables: {},
      });

      runWithRequestContext(ctx, () => {
        cookies().set("mw-cookie", "from-middleware");
      });

      // Verify via RequestContext directly
      expect(ctx.cookie("mw-cookie")).toBe("from-middleware");
    });

    it("multiple phases share the same effective state", () => {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://example.com", {
          headers: { Cookie: "original=kept" },
        }),
        url: new URL("https://example.com"),
        variables: {},
      });

      // Phase 1: middleware sets cookie
      runWithRequestContext(ctx, () => {
        cookies().set("mw", "phase1");
      });

      // Phase 2: action reads middleware cookie and sets own
      runWithRequestContext(ctx, () => {
        expect(cookies().get("mw")?.value).toBe("phase1");
        expect(cookies().get("original")?.value).toBe("kept");
        cookies().set("action", "phase2");
      });

      // Phase 3: render reads all
      runWithRequestContext(ctx, () => {
        expect(cookies().get("original")?.value).toBe("kept");
        expect(cookies().get("mw")?.value).toBe("phase1");
        expect(cookies().get("action")?.value).toBe("phase2");
      });
    });
  });

  describe("throws outside request context", () => {
    it("cookies() throws when called outside request scope", () => {
      expect(() => cookies()).toThrow();
    });
  });
});

describe("headers()", () => {
  it("returns the request headers", () => {
    withContext(
      { headers: { Authorization: "Bearer token123", "X-Custom": "value" } },
      () => {
        const h = headers();
        expect(h.get("authorization")).toBe("Bearer token123");
        expect(h.get("x-custom")).toBe("value");
      },
    );
  });

  it("returns request headers, not response headers", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com", {
        headers: { "X-Request": "yes" },
      }),
      url: new URL("https://example.com"),
      variables: {},
    });

    // Set a response header
    ctx.header("X-Response", "only-on-response");

    runWithRequestContext(ctx, () => {
      const h = headers();
      expect(h.get("x-request")).toBe("yes");
      expect(h.get("x-response")).toBeNull();
    });
  });

  it("throws on set() — headers are read-only", () => {
    withContext({ headers: { "X-Test": "value" } }, () => {
      const h = headers();
      expect(() => (h as any).set("X-Evil", "injected")).toThrow(/not allowed/);
    });
  });

  it("throws on append() — headers are read-only", () => {
    withContext({}, () => {
      const h = headers();
      expect(() => (h as any).append("X-Evil", "injected")).toThrow(
        /not allowed/,
      );
    });
  });

  it("throws on delete() — headers are read-only", () => {
    withContext({ headers: { "X-Test": "value" } }, () => {
      const h = headers();
      expect(() => (h as any).delete("X-Test")).toThrow(/not allowed/);
    });
  });

  it("has(), entries(), keys(), values() work on read-only view", () => {
    withContext({ headers: { "X-One": "1", "X-Two": "2" } }, () => {
      const h = headers();
      expect(h.has("x-one")).toBe(true);
      expect(h.has("x-missing")).toBe(false);

      const keys = [...h.keys()];
      expect(keys).toContain("x-one");
      expect(keys).toContain("x-two");

      const values = [...h.values()];
      expect(values).toContain("1");
      expect(values).toContain("2");

      const entries = [...h.entries()];
      expect(entries.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("throws outside request context", () => {
    expect(() => headers()).toThrow();
  });
});

describe('"use cache" guards', () => {
  /** Helper: create a RequestContext with INSIDE_CACHE_EXEC flag set. */
  function withCacheExecContext(fn: () => void) {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com", {
        headers: { Cookie: "session=abc", Authorization: "Bearer tok" },
      }),
      url: new URL("https://example.com"),
      variables: {},
    });

    // Simulate what cache-runtime.ts does: stamp the taint flag on ctx
    (ctx as any)[INSIDE_CACHE_EXEC] = true;

    try {
      runWithRequestContext(ctx, fn);
    } finally {
      delete (ctx as any)[INSIDE_CACHE_EXEC];
    }
  }

  it("cookies() throws inside a 'use cache' context", () => {
    withCacheExecContext(() => {
      expect(() => cookies()).toThrow(/cannot be called inside/i);
    });
  });

  it("cookies() error message mentions cache key", () => {
    withCacheExecContext(() => {
      expect(() => cookies()).toThrow(/cache key/i);
    });
  });

  it("headers() throws inside a 'use cache' context", () => {
    withCacheExecContext(() => {
      expect(() => headers()).toThrow(/cannot be called inside/i);
    });
  });

  it("cookies() works normally when INSIDE_CACHE_EXEC is not set", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com", {
        headers: { Cookie: "ok=yes" },
      }),
      url: new URL("https://example.com"),
      variables: {},
    });

    runWithRequestContext(ctx, () => {
      expect(cookies().get("ok")?.value).toBe("yes");
    });
  });

  it("headers() works normally when INSIDE_CACHE_EXEC is not set", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com", {
        headers: { "X-Test": "val" },
      }),
      url: new URL("https://example.com"),
      variables: {},
    });

    runWithRequestContext(ctx, () => {
      expect(headers().get("x-test")).toBe("val");
    });
  });
});

// Integration test with registerCachedFunction is not possible in unit tests
// because cache-runtime.ts imports @vitejs/plugin-rsc/rsc (virtual modules).
// The guard contract is tested in two parts:
//   1. cookies()/headers() check INSIDE_CACHE_EXEC on RequestContext (above)
//   2. registerCachedFunction stamps INSIDE_CACHE_EXEC on tainted args (cache-runtime.ts:252-257)
// No existing e2e suite exercises "use cache" with cookies()/headers() reads yet;
// end-to-end coverage for these guards would require a dedicated "use cache" e2e route.
