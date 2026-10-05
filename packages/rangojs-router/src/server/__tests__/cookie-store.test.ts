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
import {
  cookies,
  headers,
  invalidateClientCache,
  keepClientCache,
  type ThemeReadSurface,
} from "../cookie-store.js";
import {
  runIdentityExempt,
  runWithCacheExecScope,
} from "../../cache/cache-exec-scope.js";
import { createVar } from "../../context-var.js";
import {
  RangoContext,
  latchCachedHeaderScope,
  loaderCacheIdentityError,
  runInsideLoaderBodyScope,
  runInsideLoaderScope,
} from "../context.js";
import {
  captureRecordedTags,
  recordedIdentityRead,
} from "../../cache/cache-tag.js";
import { createHandlerContext } from "../../router/handler-context.js";
import { requestHeaders } from "../request-headers.js";
import { createMiddlewareContext } from "../../router/middleware.js";
import { payloadInitialTheme } from "../../rsc/full-payload.js";
import { resolveThemeConfig } from "../../theme/constants.js";
import { createWarmRecord } from "../../prerender/warm-request.js";

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
  /**
   * Helper: run fn on a real request context inside the "use cache" exec
   * scope — the AsyncLocalStorage frame cache-runtime.ts enters around the
   * cached body (runWithCacheExecScope), which is what the guard checks.
   */
  function withCacheExecContext(fn: () => void) {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com", {
        headers: { Cookie: "session=abc", Authorization: "Bearer tok" },
      }),
      url: new URL("https://example.com"),
      variables: {},
    });

    runWithRequestContext(ctx, () => runWithCacheExecScope(fn));
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

  it("cookies() works normally outside the exec scope", () => {
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

  it("cookies() works in a chain PARALLEL to an active 'use cache' execution", async () => {
    // The guard follows the cached body's own async chain. A sibling loader
    // reading cookies() while a slow "use cache" fetch is in flight on the
    // same request must not throw (scar: the previous stamp on the shared
    // RequestContext poisoned exactly this read for the fetch's whole window).
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com", {
        headers: { Cookie: "ok=yes" },
      }),
      url: new URL("https://example.com"),
      variables: {},
    });

    await runWithRequestContext(ctx, async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const inFlightCachedBody = runWithCacheExecScope(async () => {
        await gate;
        // Still inside the scope after resumption.
        expect(() => cookies()).toThrow(/cannot be called inside/i);
      });

      expect(cookies().get("ok")?.value).toBe("yes");
      expect(headers().get("cookie")).toBe("ok=yes");

      release();
      await inFlightCachedBody;
    });
  });

  it("headers() works normally outside the exec scope", () => {
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

describe("shell-capture guards", () => {
  /**
   * Run `fn` inside a request context with the shell-capture flag armed,
   * mirroring what the shell-cache middleware sets on the background capture
   * re-run. The captured shell is shared per URL, so request-scoped reads
   * must throw here (see guardIdentityRead in server/context.ts).
   */
  function withShellCaptureContext(fn: () => void) {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com", {
        headers: { Cookie: "session=abc", "X-User": "u1" },
      }),
      url: new URL("https://example.com"),
      variables: {},
    });

    // The ACTIVE capture marker (only the background derived context sets it),
    // not the foreground descriptor _shellCapture.
    (ctx as any)._shellCaptureRun = true;

    runWithRequestContext(ctx, fn);
  }

  it("cookies() throws during a shell-capture render", () => {
    withShellCaptureContext(() => {
      expect(() => cookies()).toThrow(/capturing a shared shell/i);
    });
  });

  it("headers() throws during a shell-capture render", () => {
    withShellCaptureContext(() => {
      expect(() => headers()).toThrow(/capturing a shared shell/i);
    });
  });

  it("the error points to loaders as the per-request lane", () => {
    withShellCaptureContext(() => {
      expect(() => cookies()).toThrow(/inside a loader/i);
    });
  });

  it("records the read and the refusal warning's fix on the capture context", () => {
    withShellCaptureContext(() => {
      expect(() => headers()).toThrow();
      expect(getRequestContext()._shellCaptureGuardTripped).toEqual({
        surface: "headers()",
        fix: expect.stringContaining("a loader without ssr: false"),
      });
    });
  });

  it("cookies()/headers() work normally when the flag is unset", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com", {
        headers: { Cookie: "ok=yes", "X-Test": "val" },
      }),
      url: new URL("https://example.com"),
      variables: {},
    });

    runWithRequestContext(ctx, () => {
      expect(cookies().get("ok")?.value).toBe("yes");
      expect(headers().get("x-test")).toBe("val");
    });
  });

  it("cookies()/headers() work on the FOREGROUND render even when a capture is wanted", () => {
    // The _shellCapture descriptor means "a capture is wanted" and is present
    // during the foreground render, which must serve the real user — so it must
    // NOT trip the guard. Only the background _shellCaptureRun does.
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com", {
        headers: { Cookie: "ok=yes", "X-Test": "val" },
      }),
      url: new URL("https://example.com"),
      variables: {},
    });
    (ctx as any)._shellCapture = { key: "example.com/:shell", ttl: 300 };

    runWithRequestContext(ctx, () => {
      expect(cookies().get("ok")?.value).toBe("yes");
      expect(headers().get("x-test")).toBe("val");
    });
  });
});

describe("cache() DSL scope guards", () => {
  /**
   * Run `fn` inside a request context AND a cache() DSL boundary — i.e. with
   * the RangoContext render-store flag `insideCacheScope = true`, mirroring
   * what segment resolution sets for a `type: "cache"` entry (fresh.ts:636).
   * This is a different ALS from the request context, so both are entered.
   */
  function withCacheScope(fn: () => void) {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com", {
        headers: { Cookie: "session=abc", Authorization: "Bearer tok" },
      }),
      url: new URL("https://example.com"),
      variables: {},
    });

    runWithRequestContext(ctx, () => {
      RangoContext.run({ insideCacheScope: true } as any, fn);
    });
  }

  it("cookies() throws inside a cache() boundary", () => {
    withCacheScope(() => {
      expect(() => cookies()).toThrow(
        /cannot be called inside a cache\(\) boundary/i,
      );
    });
  });

  it("headers() throws inside a cache() boundary", () => {
    withCacheScope(() => {
      expect(() => headers()).toThrow(
        /cannot be called inside a cache\(\) boundary/i,
      );
    });
  });

  it("cache() boundary error tells you to read inside a loader", () => {
    withCacheScope(() => {
      expect(() => cookies()).toThrow(/loader/i);
    });
  });

  it("cookies() is ALLOWED inside a loader, even within a cache() boundary", () => {
    // Loaders are the dynamic holes of a cached document: they always run
    // fresh on every request (even on a cache hit), so reading request-scoped
    // data inside a loader is safe. isInsideCacheScope() returns false here.
    withCacheScope(() => {
      runInsideLoaderScope(() => {
        expect(cookies().get("session")?.value).toBe("abc");
      });
    });
  });

  it("headers() is ALLOWED inside a loader, even within a cache() boundary", () => {
    withCacheScope(() => {
      runInsideLoaderScope(() => {
        expect(headers().get("authorization")).toBe("Bearer tok");
      });
    });
  });
});

describe("identity read guards: cookies(), headers(), the theme reads, a non-cacheable ctx.get() and the raw request reads (#971, #976)", () => {
  /** A theme-enabled request whose visitor has theme=dark. */
  function themedRequestContext(themed = true) {
    return createRequestContext({
      env: {},
      request: new Request("https://example.com", {
        headers: { Cookie: "theme=dark; session=abc", "x-probe": "probe" },
      }),
      url: new URL("https://example.com"),
      variables: {},
      themeConfig: themed ? resolveThemeConfig(true) : undefined,
    });
  }

  function handlerCtx(request = new Request("https://example.com")) {
    return createHandlerContext(
      {},
      request,
      new URLSearchParams(),
      "/",
      new URL("https://example.com"),
    );
  }

  function middlewareCtx(request = new Request("https://example.com")) {
    return createMiddlewareContext(request, {}, {}, {}, {
      response: undefined,
    } as any);
  }

  /** The public theme reads: [surface, read]. */
  const READS: Array<[ThemeReadSurface, () => unknown]> = [
    ["ctx.theme", () => handlerCtx().theme],
    ["ctx.theme", () => middlewareCtx().theme],
    ["getRequestContext().theme", () => getRequestContext().theme],
  ];

  const inCacheScope = (fn: () => void) =>
    RangoContext.run({ insideCacheScope: true } as any, () => {
      latchCachedHeaderScope("cache", "r");
      fn();
    });

  type Enter = (fn: () => void) => void;
  type Refusal = "use cache" | "cache()" | "capture";

  const Tenant = createVar<string>({ cache: false });

  /**
   * Every identity-read surface guardIdentityRead guards: its reads, the
   * value each returns where it is allowed, and the text each refusal gives
   * (the surface's own wording, ending in its fix). `fix` is what a capture
   * trip records for the refusal warning.
   */
  const SURFACES: Array<{
    surface: string;
    reads: Array<[string, () => unknown]>;
    value: unknown;
    text: Record<Refusal, string[]>;
    fix: string;
  }> = [
    {
      surface: "cookies()",
      reads: [["cookies()", () => cookies().get("theme")?.value]],
      value: "dark",
      text: {
        "use cache": [
          'cookies() cannot be called inside a "use cache" function',
          "pass it as an argument",
        ],
        "cache()": [
          "cookies() cannot be called inside a cache() boundary",
          "Read it inside a loader instead",
        ],
        capture: [
          "cookies() cannot be called while capturing a shared shell",
          "leak one user's cookies",
        ],
      },
      fix: "a loader without ssr: false",
    },
    {
      surface: "headers()",
      reads: [["headers()", () => headers().get("x-probe")]],
      value: "probe",
      text: {
        "use cache": [
          'headers() cannot be called inside a "use cache" function',
          "pass it as an argument",
        ],
        "cache()": [
          "headers() cannot be called inside a cache() boundary",
          "Read it inside a loader instead",
        ],
        capture: [
          "headers() cannot be called while capturing a shared shell",
          "leak one user's headers",
        ],
      },
      fix: "a loader without ssr: false",
    },
    ...(["ctx.theme", "getRequestContext().theme"] as const).map((surface) => ({
      surface,
      reads: READS.filter(([s]) => s === surface).map(
        ([s, read], i): [string, () => unknown] => [`${s} #${i}`, read],
      ),
      value: "dark",
      text: {
        "use cache": [
          `${surface} cannot be read inside a "use cache" function`,
          "pass it in as an argument",
        ],
        "cache()": [
          `${surface} cannot be read inside a cache() boundary`,
          "useTheme()",
          "live loader (no ssr: false)",
        ],
        capture: [
          `${surface} cannot be read while capturing a shared shell`,
          "useTheme()",
        ],
      },
      fix: "useTheme()",
    })),
    // #976: the raw reads. The router hands the request context's Request
    // to every ctx, so each ctx's request.headers is the same guarded getter.
    {
      surface: "ctx.request.headers",
      reads: [
        [
          "getRequestContext().request.headers",
          () => getRequestContext().request.headers.get("x-probe"),
        ],
        [
          "handler ctx.request.headers",
          () =>
            handlerCtx(getRequestContext().request).request.headers.get(
              "x-probe",
            ),
        ],
        [
          "middleware ctx.request.headers",
          () =>
            middlewareCtx(getRequestContext().request).request.headers.get(
              "x-probe",
            ),
        ],
      ],
      value: "probe",
      text: {
        "use cache": [
          'ctx.request.headers cannot be read inside a "use cache" function',
          "pass it as an argument",
        ],
        "cache()": [
          "ctx.request.headers cannot be read inside a cache() boundary",
          "Read it inside a loader instead",
        ],
        capture: [
          "ctx.request.headers cannot be read while capturing a shared shell",
          "leak one user's headers",
        ],
      },
      fix: "a loader without ssr: false",
    },
    ...(
      [
        [
          "getRequestContext().cookie()",
          () => getRequestContext().cookie("session"),
        ],
        [
          "getRequestContext().cookies()",
          () => getRequestContext().cookies().session,
        ],
      ] as const
    ).map(([surface, read]) => ({
      surface,
      reads: [[surface, read]] as Array<[string, () => unknown]>,
      value: "abc",
      text: {
        "use cache": [
          `${surface} cannot be called inside a "use cache" function`,
          "pass it as an argument",
        ],
        "cache()": [
          `${surface} cannot be called inside a cache() boundary`,
          "Read it inside a loader instead",
        ],
        capture: [
          `${surface} cannot be called while capturing a shared shell`,
          "leak one user's cookies",
        ],
      },
      fix: "a loader without ssr: false",
    })),
    {
      surface: "ctx.get() for a non-cacheable variable",
      reads: [
        ["getRequestContext().get", () => getRequestContext().get(Tenant)],
        ["handler ctx.get", () => handlerCtx().get(Tenant)],
      ],
      value: "t1",
      text: {
        "use cache": [
          'ctx.get() for a non-cacheable variable cannot be called inside a "use cache" function',
          "pass the value in as an argument",
        ],
        "cache()": [
          "ctx.get() for a non-cacheable variable cannot be called inside a cache() boundary",
          "Move the read outside the cached scope",
        ],
        capture: [
          "ctx.get() for a non-cacheable variable cannot be called while capturing a shared shell",
          "leak one user's per-request variables",
        ],
      },
      fix: "a loader without ssr: false",
    },
    {
      surface: 'ctx.get() for a non-cacheable variable "site"',
      reads: [
        ["getRequestContext().get", () => getRequestContext().get("site")],
      ],
      value: "s1",
      text: {
        "use cache": [
          'ctx.get() for a non-cacheable variable "site" cannot be called inside a "use cache" function',
        ],
        "cache()": [
          'ctx.get() for a non-cacheable variable "site" cannot be called inside a cache() boundary',
        ],
        capture: [
          'ctx.get() for a non-cacheable variable "site" cannot be called while capturing a shared shell',
        ],
      },
      fix: "a loader without ssr: false",
    },
  ];

  /**
   * Every scope the ladder decides: [label, the refusal or "allowed",
   * capture render, enter, the loader body a capture trip names].
   */
  const SCOPES: Array<[string, Refusal | "allowed", boolean, Enter, string?]> =
    [
      ["no shared scope", "allowed", false, (fn) => fn()],
      [
        "a loader body outside any cache scope",
        "allowed",
        false,
        (fn) => runInsideLoaderBodyScope(fn, "L"),
      ],
      [
        'a "use cache" body',
        "use cache",
        false,
        (fn) => runWithCacheExecScope(fn),
      ],
      // Its value is part of what the function returns, stored in the entry
      // under a key that does not include what it read. A non-cacheable
      // ctx.get() was exempt here before, and the entry kept the first
      // request's value.
      [
        'a loader body entered inside a "use cache" function',
        "use cache",
        false,
        (fn) => runWithCacheExecScope(() => runInsideLoaderBodyScope(fn, "L")),
      ],
      [
        'a DSL loader inside a "use cache" function',
        "use cache",
        false,
        (fn) => runWithCacheExecScope(() => runInsideLoaderScope(fn)),
      ],
      [
        'a "use cache" function a loader body calls',
        "use cache",
        false,
        (fn) => runInsideLoaderBodyScope(() => runWithCacheExecScope(fn), "L"),
      ],
      ["a cache() boundary", "cache()", false, inCacheScope],
      [
        "a DSL loader under cache()",
        "allowed",
        false,
        (fn) => inCacheScope(() => runInsideLoaderScope(fn)),
      ],
      [
        "a handler-invoked loader body under cache()",
        "allowed",
        false,
        (fn) => inCacheScope(() => runInsideLoaderBodyScope(fn, "L")),
      ],
      ["a ppr capture render", "capture", true, (fn) => fn()],
      [
        "a segment loader body at capture",
        "capture",
        true,
        (fn) => runInsideLoaderBodyScope(fn, "L"),
        "L",
      ],
      // No loader-body exemption at capture (#969): a HIT replays the
      // capture's copy of a loader a handler awaits.
      [
        "a handler-invoked loader body at capture",
        "capture",
        true,
        (fn) => runInsideLoaderBodyScope(fn, "L"),
        "L",
      ],
      // The capture trips first: a caught throw still refuses the capture.
      [
        'a "use cache" body at capture',
        "capture",
        true,
        (fn) => runWithCacheExecScope(fn),
      ],
      ["a cache() boundary at capture", "capture", true, inCacheScope],
      // A key(), a store keyGenerator or a condition() (#976): the value
      // picks the entry, it is not stored in it. A capture resolves its doc
      // record key under the capture context.
      [
        "a cache decision (key(), keyGenerator, condition())",
        "allowed",
        false,
        (fn) => runIdentityExempt(fn),
      ],
      [
        "a cache decision in a cache() boundary",
        "allowed",
        false,
        (fn) => inCacheScope(() => runIdentityExempt(fn)),
      ],
      [
        'a cache decision in a "use cache" body',
        "allowed",
        false,
        (fn) => runWithCacheExecScope(() => runIdentityExempt(fn)),
      ],
      [
        "a cache decision at capture",
        "allowed",
        true,
        (fn) => runIdentityExempt(fn),
      ],
    ];

  /** The error `fn` throws, or "allowed". */
  function readOutcome(fn: () => unknown): Error | "allowed" {
    try {
      fn();
      return "allowed";
    } catch (error) {
      return error as Error;
    }
  }

  describe.each(SCOPES)(
    "in %s, every identity read gets the same answer",
    (_label, expected, capture, enter, loaderId) => {
      it.each(SURFACES)("$surface", ({ surface, reads, value, text, fix }) => {
        const reqCtx = themedRequestContext();
        reqCtx.set(Tenant, "t1");
        reqCtx.set("site", "s1", { cache: false });
        if (capture) (reqCtx as any)._shellCaptureRun = true;
        runWithRequestContext(reqCtx, () =>
          enter(() => {
            for (const [, read] of reads) {
              reqCtx._shellCaptureGuardTripped = undefined;
              // The ctx is created inside the scope: creating it reads nothing.
              if (expected === "allowed") {
                expect(read()).toBe(value);
                expect(reqCtx._shellCaptureGuardTripped).toBeUndefined();
                continue;
              }
              const outcome = readOutcome(read);
              expect(outcome).toBeInstanceOf(Error);
              for (const part of text[expected]) {
                expect((outcome as Error).message).toContain(part);
              }
              if (capture) {
                expect(reqCtx._shellCaptureGuardTripped).toEqual({
                  surface,
                  fix: expect.stringContaining(fix),
                });
                expect(reqCtx._shellCaptureGuardTrippedLoaderId).toBe(loaderId);
              }
            }
          }),
        );
      });
    },
  );

  it("reads the visitor's theme where nothing is shared, and a theme set earlier in the request", () => {
    runWithRequestContext(themedRequestContext(), () => {
      const ctx = handlerCtx();
      expect([ctx.theme, getRequestContext().theme]).toEqual(["dark", "dark"]);
      ctx.setTheme!("light");
      expect([ctx.theme, getRequestContext().theme]).toEqual([
        "light",
        "light",
      ]);
    });
  });

  it("a handler ctx read with no ambient request context is guarded by the ctx's own", () => {
    const reqCtx = themedRequestContext();
    (reqCtx as any)._shellCaptureRun = true;
    const ctx = runWithRequestContext(reqCtx, () => handlerCtx());
    expect(() => ctx.theme).toThrow(
      "ctx.theme cannot be read while capturing a shared shell",
    );
    expect(reqCtx._shellCaptureGuardTripped?.surface).toBe("ctx.theme");
  });

  it("at capture, serializing a ctx does not read the theme; a derived ctx's read does", () => {
    // React's dev debug info JSON-stringifies server component props and
    // replayed console.log args; a ctx passed there is not a theme read.
    const reqCtx = themedRequestContext();
    (reqCtx as any)._shellCaptureRun = true;
    runWithRequestContext(reqCtx, () => {
      const ctx = handlerCtx();
      for (const serialized of [ctx, reqCtx]) {
        expect(() => JSON.stringify(serialized)).not.toThrow();
        expect(Object.keys(serialized)).not.toContain("theme");
        expect({ ...serialized }).not.toHaveProperty("theme");
      }
      expect(reqCtx._shellCaptureGuardTripped).toBeUndefined();
      // cache-runtime.ts refreshView wraps the ctx with Object.create.
      expect(() => Object.create(ctx).theme).toThrow(/ctx\.theme/);
      expect(reqCtx._shellCaptureGuardTripped?.surface).toBe("ctx.theme");
    });
  });

  it('the middleware ctx.theme is non-enumerable: spreading the ctx in a "use cache" body does not read it', () => {
    runWithRequestContext(themedRequestContext(), () => {
      const ctx = middlewareCtx();
      expect(Object.getOwnPropertyDescriptor(ctx, "theme")?.enumerable).toBe(
        false,
      );
      runWithCacheExecScope(() => {
        expect(() => ({ ...ctx })).not.toThrow();
        expect(() => ctx.theme).toThrow(
          'ctx.theme cannot be read inside a "use cache" function',
        );
      });
      expect(ctx.theme).toBe("dark");
    });
  });

  it("a spread of the request context (the fetchable-loader ctx) carries no unguarded theme read", () => {
    const reqCtx = themedRequestContext();
    (reqCtx as any)._shellCaptureRun = true;
    runWithRequestContext(reqCtx, () => {
      // loader-fetch.ts builds the fetchable-loader ctx as { ...reqCtx }.
      const copy = { ...reqCtx } as Record<string, unknown>;
      expect(copy).not.toHaveProperty("theme");
      expect(copy).not.toHaveProperty("_readTheme");
      expect(reqCtx._shellCaptureGuardTripped).toBeUndefined();
      // The internal read itself still works for the router.
      expect(reqCtx._readTheme()).toBe("dark");
    });
  });

  it("the theme is read-only: assigning it throws", () => {
    runWithRequestContext(themedRequestContext(), () => {
      const ctx = handlerCtx();
      expect(() => {
        (ctx as { theme?: string }).theme = "light";
      }).toThrow(TypeError);
      expect(() => {
        (getRequestContext() as { theme?: string }).theme = "light";
      }).toThrow(TypeError);
      expect(ctx.theme).toBe("dark");
    });
  });

  it("the foreground render of a ppr route reads the visitor's theme", () => {
    const reqCtx = themedRequestContext();
    (reqCtx as any)._shellCapture = { key: "example.com/:shell", ttl: 300 };
    runWithRequestContext(reqCtx, () => {
      expect(READS.map(([, read]) => read())).toEqual(["dark", "dark", "dark"]);
    });
  });

  it("without theme config every theme read is undefined and never throws", () => {
    const reqCtx = themedRequestContext(false);
    (reqCtx as any)._shellCaptureRun = true;
    runWithRequestContext(reqCtx, () => {
      for (const enter of [inCacheScope, runWithCacheExecScope] as Enter[]) {
        enter(() => {
          for (const [, read] of READS) expect(read()).toBeUndefined();
        });
      }
      expect(reqCtx._shellCaptureGuardTripped).toBeUndefined();
    });
  });

  it("the router's payload read is unguarded; a capture carries the no-cookie default", () => {
    const reqCtx = themedRequestContext();
    runWithRequestContext(reqCtx, () => {
      inCacheScope(() => expect(payloadInitialTheme(reqCtx)).toBe("dark"));
      runWithCacheExecScope(() =>
        expect(payloadInitialTheme(reqCtx)).toBe("dark"),
      );
    });
    const derived = Object.create(reqCtx) as typeof reqCtx;
    derived._shellCaptureRun = true;
    runWithRequestContext(derived, () => {
      expect(payloadInitialTheme(derived)).toBe("system");
      expect(derived._shellCaptureGuardTripped).toBeUndefined();
    });
    expect(payloadInitialTheme(themedRequestContext(false))).toBeUndefined();
  });

  it("a render the document cache stores carries the no-cookie default; any other render marks a visitor theme (#978)", () => {
    const stored = themedRequestContext();
    stored._documentCacheRender = true;
    stored.header("Cache-Control", "s-maxage=60");
    expect(payloadInitialTheme(stored)).toBe("system");
    expect(stored._payloadVisitorTheme).toBeUndefined();

    // Not stored: no s-maxage yet, or no document-cache middleware.
    const unstored = themedRequestContext();
    unstored._documentCacheRender = true;
    expect(payloadInitialTheme(unstored)).toBe("dark");
    expect(unstored._payloadVisitorTheme).toBe(true);
    const unmarked = themedRequestContext();
    unmarked.header("Cache-Control", "s-maxage=60");
    expect(payloadInitialTheme(unmarked)).toBe("dark");
    expect(unmarked._payloadVisitorTheme).toBe(true);

    // A visitor with no stored theme renders the default: nothing to mark.
    const anonymous = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
      themeConfig: resolveThemeConfig(true),
    });
    expect(payloadInitialTheme(anonymous)).toBe("system");
    expect(anonymous._payloadVisitorTheme).toBeUndefined();
  });

  it("ctx.setTheme throws in a cache() boundary like cookies().set, and leaves no cookie", () => {
    const reqCtx = themedRequestContext();
    runWithRequestContext(reqCtx, () => {
      const ctx = handlerCtx();
      inCacheScope(() => {
        expect(() => cookies().set("theme", "light")).toThrow();
        expect(() => ctx.setTheme!("light")).toThrow(
          /inside a cache\(\) boundary/,
        );
      });
      expect(reqCtx.res.headers.get("Set-Cookie")).toBeNull();
    });
  });

  it('ctx.setTheme throws in a "use cache" body like cookies().set', () => {
    runWithRequestContext(themedRequestContext(), () => {
      const ctx = handlerCtx();
      runWithCacheExecScope(() => {
        expect(() => cookies().set("theme", "light")).toThrow();
        expect(() => ctx.setTheme!("light")).toThrow(/"use cache"/);
      });
    });
  });
});

describe("identity reads refused on a router.prerender() warm request", () => {
  type Enter = (ctx: unknown, fn: () => void) => void;
  const SURFACES: Array<[string, () => unknown]> = [
    ["cookies()", () => cookies().get("session")],
    ["headers()", () => headers().get("authorization")],
  ];

  function warmContext() {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com", {
        headers: { Cookie: "session=abc", Authorization: "Bearer tok" },
      }),
      url: new URL("https://example.com"),
      variables: {},
    });
    const record = createWarmRecord("replace", {} as any);
    ctx._prerenderWarm = record;
    return { ctx, record };
  }

  const scopes: Array<[string, Enter]> = [
    [
      "a capture context",
      (ctx, fn) => {
        (ctx as any)._shellCaptureRun = true;
        runWithRequestContext(ctx as any, fn);
      },
    ],
    [
      "a cache() boundary",
      (ctx, fn) =>
        runWithRequestContext(ctx as any, () =>
          RangoContext.run({ insideCacheScope: true } as any, fn),
        ),
    ],
    [
      'a "use cache" execution',
      (ctx, fn) =>
        runWithRequestContext(ctx as any, () => runWithCacheExecScope(fn)),
    ],
  ];

  for (const [scopeLabel, enter] of scopes) {
    for (const [surface, read] of SURFACES) {
      it(`${surface} refused in ${scopeLabel} records the surface and still throws`, () => {
        const { ctx, record } = warmContext();
        let threw = false;
        enter(ctx, () => {
          try {
            read();
          } catch {
            threw = true;
          }
        });

        expect(threw).toBe(true);
        expect(record.identity).toBe(surface);
      });
    }
  }

  it("a read outside any cached scope does not throw and records no identity", () => {
    const { ctx, record } = warmContext();
    runWithRequestContext(ctx, () => {
      expect(cookies().get("session")?.value).toBe("abc");
      expect(headers().get("authorization")).toBe("Bearer tok");
    });
    expect(record.identity).toBeUndefined();
  });

  it("a read allowed inside a loader within a cache() boundary records no identity", () => {
    const { ctx, record } = warmContext();
    runWithRequestContext(ctx, () =>
      RangoContext.run({ insideCacheScope: true } as any, () =>
        runInsideLoaderScope(() => {
          expect(cookies().get("session")?.value).toBe("abc");
        }),
      ),
    );
    expect(record.identity).toBeUndefined();
  });

  it("the first refused surface is kept when a second one is refused", () => {
    const { ctx, record } = warmContext();
    runWithRequestContext(ctx, () =>
      runWithCacheExecScope(() => {
        expect(() => headers()).toThrow(/cannot be called inside/i);
        expect(() => cookies()).toThrow(/cannot be called inside/i);
      }),
    );
    expect(record.identity).toBe("headers()");
  });
});

describe("identity reads recorded for a loader cache() fill (#972)", () => {
  /** Run `fn` in a fill's recorded set; return the read it recorded. */
  function recordedBy(fn: () => void) {
    const into = new Set<string>();
    withContext({ cookieHeader: "session=abc" }, () =>
      captureRecordedTags(into, fn),
    );
    return recordedIdentityRead(into);
  }

  it("cookies() and headers() record the read, not throw", () => {
    expect(recordedBy(() => cookies().get("session"))).toEqual({
      surface: "cookies()",
      verb: "called",
      bodyId: undefined,
    });
    expect(recordedBy(() => headers().get("cookie"))?.surface).toBe(
      "headers()",
    );
  });

  it("a clone of ctx.request records its header read for a loader cache() fill (#976)", () => {
    expect(
      recordedBy(() =>
        getRequestContext().request.clone().headers.get("cookie"),
      )?.surface,
    ).toBe("ctx.request.headers");
  });

  it("ctx.request.headers and getRequestContext().cookie()/cookies() record at the read (#976)", () => {
    expect(
      recordedBy(() => getRequestContext().request.headers.get("cookie")),
    ).toEqual({
      surface: "ctx.request.headers",
      verb: "read",
      bodyId: undefined,
    });
    expect(recordedBy(() => getRequestContext().cookie("session"))).toEqual({
      surface: "getRequestContext().cookie()",
      verb: "called",
      bodyId: undefined,
    });
    expect(recordedBy(() => getRequestContext().cookies())?.surface).toBe(
      "getRequestContext().cookies()",
    );
  });

  it("a cache decision (key(), keyGenerator, condition()) records nothing (#976)", () => {
    expect(
      recordedBy(() =>
        runIdentityExempt(() => {
          cookies().get("session");
          headers().get("cookie");
          getRequestContext().request.headers.get("cookie");
          getRequestContext().cookie("session");
        }),
      ),
    ).toBeUndefined();
  });

  it("the router's own request reads record nothing (#976)", () => {
    expect(
      recordedBy(() => {
        const ctx = getRequestContext();
        requestHeaders(ctx.request).get("cookie");
        ctx._readCookie("session");
        ctx._readCookies();
        cookies().set("seen", "1");
        invalidateClientCache();
      }),
    ).toBeUndefined();
  });

  it("response directives record nothing: a key() cannot replay them on a HIT", () => {
    expect(
      recordedBy(() => {
        invalidateClientCache();
        keepClientCache();
      }),
    ).toBeUndefined();
  });

  it("headers() records on its read methods, not the call: a view taken outside and read inside counts", () => {
    expect(recordedBy(() => headers())).toBeUndefined();
    const into = new Set<string>();
    withContext({ headers: { "x-user": "u1" } }, () => {
      const view = headers();
      captureRecordedTags(into, () => {
        view.get("x-user");
      });
    });
    expect(recordedIdentityRead(into)?.surface).toBe("headers()");
    for (const read of [
      (h: ReturnType<typeof headers>) => h.has("x-user"),
      (h: ReturnType<typeof headers>) => [...h],
      (h: ReturnType<typeof headers>) => h.forEach(() => {}),
    ]) {
      expect(recordedBy(() => read(headers()))?.surface).toBe("headers()");
    }
  });

  it("a cookie write records nothing; its read methods do", () => {
    expect(recordedBy(() => cookies().set("seen", "1"))).toBeUndefined();
    for (const read of [
      (jar: ReturnType<typeof cookies>) => jar.getAll(),
      (jar: ReturnType<typeof cookies>) => jar.has("session"),
    ]) {
      expect(recordedBy(() => read(cookies()))?.surface).toBe("cookies()");
    }
  });

  it("a shell-capture run keeps its own guard, which flags the capture", () => {
    recordedBy(() => {
      const ctx = getRequestContext() as any;
      ctx._shellCaptureRun = true;
      expect(() => cookies()).toThrow(/capturing a shared shell/i);
      expect(ctx._shellCaptureGuardTripped).toMatchObject({
        surface: "cookies()",
      });
    });
  });

  it("the fill error names the loader and the fix", () => {
    const read = recordedBy(() => cookies().get("session"))!;
    expect(loaderCacheIdentityError(read, "SessionLoader#L").message).toMatch(
      /^cookies\(\) cannot be called inside loader "SessionLoader#L", whose own cache\(\) has no key\(\)\..*key: \(ctx\) =>/s,
    );
  });
});

// The guard contract is tested in three parts:
//   1. cookies()/headers() check the cache-exec ALS scope (above) — the scope
//      cache-runtime.ts enters around the cached body via runWithCacheExecScope
//   2. registerCachedFunction stamps INSIDE_CACHE_EXEC on tainted ARG objects
//      for the ctx.set()/ctx.header() guards (cache-runtime.ts)
//   3. the production registerCachedFunction path (mocked virtual modules) in
//      src/cache/__tests__/cache-exec-parallel-guard.test.ts — in-body reads
//      throw, PARALLEL same-request reads don't
// The full transformed path (Vite transform -> registerCachedFunction -> guard -> throw)
// is covered by e2e/use-cache.test.ts:
//   "cookies() throws inside a 'use cache' function"
//   "headers() throws inside a 'use cache' function"
