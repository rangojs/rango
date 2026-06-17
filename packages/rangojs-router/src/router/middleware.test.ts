import { describe, it, expect, vi } from "vitest";
import {
  parsePattern,
  extractParams,
  matchMiddleware,
  executeMiddleware,
  executeInterceptMiddleware,
  executeLoaderMiddleware,
  collectRouteMiddleware,
  type MiddlewareFn,
  type MiddlewareEntry,
} from "./middleware";
import type { MiddlewareCollectableEntry } from "./middleware-types.js";
import { cookies } from "../server/cookie-store.js";
import {
  createRequestContext,
  runWithRequestContext,
  parseCookiesFromHeader as parseCookies,
  serializeCookieValue as serializeCookie,
} from "../server/request-context.js";
import { createResponseWithMergedHeaders } from "../rsc/helpers.js";
import { resolveTracing } from "./tracing.js";
import type { MetricsStore } from "../server/context.js";

function recordingTracing() {
  const spans: string[] = [];
  return {
    spans,
    tracing: resolveTracing({
      runner: (name, fn) => {
        spans.push(name);
        return fn({ setAttribute() {} });
      },
    }),
  };
}

function createMetrics(): MetricsStore {
  return { enabled: true, requestStart: performance.now(), metrics: [] };
}

function runWithMetrics<T>(metrics: MetricsStore, fn: () => T): T {
  const reqCtx = createRequestContext({
    env: {},
    request: new Request("http://localhost/"),
    url: new URL("http://localhost/"),
    variables: {},
  });
  reqCtx._metricsStore = metrics;
  return runWithRequestContext(reqCtx, fn);
}

describe("middleware", () => {
  describe("parsePattern", () => {
    it("should match all routes with *", () => {
      const { regex } = parsePattern("*");
      expect(regex.test("/")).toBe(true);
      expect(regex.test("/foo")).toBe(true);
      expect(regex.test("/foo/bar/baz")).toBe(true);
    });

    it("should match exact path", () => {
      const { regex } = parsePattern("/admin");
      expect(regex.test("/admin")).toBe(true);
      expect(regex.test("/admin/")).toBe(true);
      expect(regex.test("/admin/users")).toBe(false);
      expect(regex.test("/administrator")).toBe(false);
    });

    it("should match prefix with wildcard", () => {
      const { regex } = parsePattern("/admin/*");
      expect(regex.test("/admin")).toBe(true);
      expect(regex.test("/admin/")).toBe(true);
      expect(regex.test("/admin/users")).toBe(true);
      expect(regex.test("/admin/users/123")).toBe(true);
      expect(regex.test("/administrator")).toBe(false);
    });

    it("should extract params from pattern", () => {
      const { regex, paramNames } = parsePattern("/users/:id");
      expect(paramNames).toEqual(["id"]);
      expect(regex.test("/users/123")).toBe(true);
      expect(regex.test("/users/abc")).toBe(true);
      expect(regex.test("/users/")).toBe(false);
    });

    it("should extract multiple params", () => {
      const { regex, paramNames } = parsePattern(
        "/users/:userId/posts/:postId",
      );
      expect(paramNames).toEqual(["userId", "postId"]);
      expect(regex.test("/users/123/posts/456")).toBe(true);
    });

    it("should handle param with wildcard", () => {
      const { regex, paramNames } = parsePattern("/api/:version/*");
      expect(paramNames).toEqual(["version"]);
      expect(regex.test("/api/v1/users")).toBe(true);
      expect(regex.test("/api/v2/users/123")).toBe(true);
    });
  });

  describe("extractParams", () => {
    it("should extract single param", () => {
      const { regex, paramNames } = parsePattern("/users/:id");
      const params = extractParams("/users/123", regex, paramNames);
      expect(params).toEqual({ id: "123" });
    });

    it("should extract multiple params", () => {
      const { regex, paramNames } = parsePattern(
        "/users/:userId/posts/:postId",
      );
      const params = extractParams("/users/abc/posts/xyz", regex, paramNames);
      expect(params).toEqual({ userId: "abc", postId: "xyz" });
    });

    it("should return empty object for no match", () => {
      const { regex, paramNames } = parsePattern("/users/:id");
      const params = extractParams("/posts/123", regex, paramNames);
      expect(params).toEqual({});
    });

    it("should URL-decode param values", () => {
      const { regex, paramNames } = parsePattern("/mailbox/:id");
      const params = extractParams(
        "/mailbox/ivo%40example.com",
        regex,
        paramNames,
      );
      expect(params).toEqual({ id: "ivo@example.com" });
    });

    it("should preserve malformed percent-encoding as raw", () => {
      const { regex, paramNames } = parsePattern("/users/:id");
      const params = extractParams("/users/broken%ZZ", regex, paramNames);
      expect(params).toEqual({ id: "broken%ZZ" });
    });
  });

  describe("parseCookies", () => {
    it("should parse single cookie", () => {
      const cookies = parseCookies("session=abc123");
      expect(cookies).toEqual({ session: "abc123" });
    });

    it("should parse multiple cookies", () => {
      const cookies = parseCookies("session=abc123; user=john; theme=dark");
      expect(cookies).toEqual({
        session: "abc123",
        user: "john",
        theme: "dark",
      });
    });

    it("should handle encoded values", () => {
      const cookies = parseCookies("data=hello%20world");
      expect(cookies).toEqual({ data: "hello world" });
    });

    it("should return empty object for null", () => {
      const cookies = parseCookies(null);
      expect(cookies).toEqual({});
    });

    it("should handle malformed percent-encoded values", () => {
      const cookies = parseCookies("bad=%zz; good=hello%20world");
      expect(cookies).toEqual({ bad: "%zz", good: "hello world" });
    });
  });

  describe("serializeCookie", () => {
    it("should serialize basic cookie", () => {
      const cookie = serializeCookie("session", "abc123");
      expect(cookie).toBe("session=abc123");
    });

    it("should include all options", () => {
      const cookie = serializeCookie("session", "abc123", {
        domain: "example.com",
        path: "/",
        maxAge: 3600,
        httpOnly: true,
        secure: true,
        sameSite: "lax",
      });
      expect(cookie).toContain("session=abc123");
      expect(cookie).toContain("Domain=example.com");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("Max-Age=3600");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=lax");
    });

    it("should handle expires date", () => {
      const expires = new Date("2025-01-01T00:00:00Z");
      const cookie = serializeCookie("session", "abc123", { expires });
      expect(cookie).toContain("Expires=Wed, 01 Jan 2025 00:00:00 GMT");
    });
  });

  describe("matchMiddleware", () => {
    it("should match global middleware (no pattern)", () => {
      const entries: MiddlewareEntry<unknown>[] = [
        {
          pattern: null,
          regex: null,
          paramNames: [],
          handler: vi.fn(),
        },
      ];
      const matches = matchMiddleware("/any/path", entries);
      expect(matches).toHaveLength(1);
    });

    it("should match pattern-based middleware", () => {
      const { regex, paramNames } = parsePattern("/admin/*");
      const entries: MiddlewareEntry<unknown>[] = [
        {
          pattern: "/admin/*",
          regex,
          paramNames,
          handler: vi.fn(),
        },
      ];

      expect(matchMiddleware("/admin/users", entries)).toHaveLength(1);
      expect(matchMiddleware("/public", entries)).toHaveLength(0);
    });

    it("should extract params when matching", () => {
      const { regex, paramNames } = parsePattern("/users/:id/*");
      const entries: MiddlewareEntry<unknown>[] = [
        {
          pattern: "/users/:id/*",
          regex,
          paramNames,
          handler: vi.fn(),
        },
      ];

      const matches = matchMiddleware("/users/123/posts", entries);
      expect(matches).toHaveLength(1);
      expect(matches[0].params).toEqual({ id: "123" });
    });

    it("should return multiple matches in order", () => {
      const entries: MiddlewareEntry<unknown>[] = [
        {
          pattern: null,
          regex: null,
          paramNames: [],
          handler: vi.fn(),
        },
        {
          pattern: "/admin/*",
          ...parsePattern("/admin/*"),
          handler: vi.fn(),
        },
      ];

      const matches = matchMiddleware("/admin/users", entries);
      expect(matches).toHaveLength(2);
    });
  });

  describe("executeMiddleware", () => {
    const createMockEntry = (
      handler: MiddlewareFn<unknown>,
    ): { entry: MiddlewareEntry<unknown>; params: Record<string, string> } => ({
      entry: {
        pattern: null,
        regex: null,
        paramNames: [],
        handler,
      },
      params: {},
    });

    it("should execute single middleware and return response", async () => {
      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        const response = await next();
        response.headers.set("X-Test", "value");
        return response;
      };

      const response = await executeMiddleware(
        [createMockEntry(middleware)],
        new Request("http://localhost/test"),
        {},
        {},
        async () => new Response("OK"),
      );

      expect(response.headers.get("X-Test")).toBe("value");
      expect(await response.text()).toBe("OK");
    });

    it("should strip _rsc* params from ctx.url and ctx.searchParams", async () => {
      let capturedUrl: URL | undefined;
      let capturedSearchParams: URLSearchParams | undefined;
      let capturedOriginalUrl: URL | undefined;

      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        capturedUrl = ctx.url;
        capturedSearchParams = ctx.searchParams;
        capturedOriginalUrl = ctx.originalUrl;
        return next();
      };

      await executeMiddleware(
        [createMockEntry(middleware)],
        new Request(
          "http://localhost/test?q=hello&_rsc_partial=1&_rsc_segments=M0&page=2",
        ),
        {},
        {},
        async () => new Response("OK"),
      );

      // ctx.url should have _rsc* stripped
      expect(capturedUrl!.searchParams.has("_rsc_partial")).toBe(false);
      expect(capturedUrl!.searchParams.has("_rsc_segments")).toBe(false);
      expect(capturedUrl!.searchParams.get("q")).toBe("hello");
      expect(capturedUrl!.searchParams.get("page")).toBe("2");

      // ctx.searchParams should match ctx.url.searchParams
      expect(capturedSearchParams).toBe(capturedUrl!.searchParams);
      expect(capturedSearchParams!.has("_rsc_partial")).toBe(false);

      // ctx.originalUrl should preserve all params
      expect(capturedOriginalUrl!.searchParams.has("_rsc_partial")).toBe(true);
      expect(capturedOriginalUrl!.searchParams.has("_rsc_segments")).toBe(true);
      expect(capturedOriginalUrl!.searchParams.get("q")).toBe("hello");
    });

    it("should execute middleware in order", async () => {
      const order: number[] = [];

      const mw1: MiddlewareFn<unknown> = async (ctx, next) => {
        order.push(1);
        await next();
        order.push(4);
      };

      const mw2: MiddlewareFn<unknown> = async (ctx, next) => {
        order.push(2);
        await next();
        order.push(3);
      };

      await executeMiddleware(
        [createMockEntry(mw1), createMockEntry(mw2)],
        new Request("http://localhost/test"),
        {},
        {},
        async () => new Response("OK"),
      );

      expect(order).toEqual([1, 2, 3, 4]);
    });

    it("should record middleware timing only until next() is called", async () => {
      const metrics = createMetrics();
      let releaseNext!: (response: Response) => void;

      async function auth(ctx: any, next: any) {
        const pending = next();
        const recorded = metrics.metrics.find(
          (m) => m.label === "middleware:auth@*:pre",
        );
        expect(recorded).toBeDefined();
        await pending;
      }

      const execution = runWithMetrics(metrics, () =>
        executeMiddleware(
          [createMockEntry(auth)],
          new Request("http://localhost/test"),
          {},
          {},
          () =>
            new Promise<Response>((resolve) => {
              releaseNext = resolve;
            }),
        ),
      );

      await new Promise((resolve) => setTimeout(resolve, 0));

      const recorded = metrics.metrics.find(
        (m) => m.label === "middleware:auth@*:pre",
      );
      expect(recorded).toBeDefined();
      expect(recorded!.depth).toBe(1);
      expect(metrics.metrics).toHaveLength(1);

      releaseNext(new Response("OK"));
      await execution;

      expect(
        metrics.metrics.filter((m) => m.label === "middleware:auth@*:pre"),
      ).toHaveLength(1);
    });

    it("should record middleware timing for short-circuit responses before next()", async () => {
      const metrics = createMetrics();

      async function guard() {
        return new Response("Blocked", { status: 403 });
      }

      await runWithMetrics(metrics, () =>
        executeMiddleware(
          [createMockEntry(guard)],
          new Request("http://localhost/test"),
          {},
          {},
          async () => new Response("OK"),
        ),
      );

      const recorded = metrics.metrics.find(
        (m) => m.label === "middleware:guard@*:pre",
      );
      expect(recorded).toBeDefined();
      expect(recorded!.depth).toBe(1);
      expect(recorded!.duration).toBeGreaterThanOrEqual(0);
    });

    it("should create metrics during middleware debugPerformance() and record the current span", async () => {
      let releaseNext!: (response: Response) => void;
      let reqCtx!: ReturnType<typeof createRequestContext>;

      async function auth(ctx: any, next: any) {
        ctx.debugPerformance();
        expect(reqCtx._metricsStore).toBeDefined();
        const pending = next();
        const recorded = reqCtx._metricsStore?.metrics.find(
          (m) => m.label === "middleware:auth@*:pre",
        );
        expect(recorded).toBeDefined();
        await pending;
      }

      reqCtx = createRequestContext({
        env: {},
        request: new Request("http://localhost/test"),
        url: new URL("http://localhost/test"),
        variables: {},
      });

      const execution = runWithRequestContext(reqCtx, () =>
        executeMiddleware(
          [createMockEntry(auth)],
          new Request("http://localhost/test"),
          {},
          {},
          () =>
            new Promise<Response>((resolve) => {
              releaseNext = resolve;
            }),
        ),
      );

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(
        reqCtx._metricsStore?.metrics.some(
          (m) => m.label === "middleware:auth@*:pre",
        ),
      ).toBe(true);

      releaseNext(new Response("OK"));
      await execution;
    });

    it("should record post-phase timing for work after next() resolves", async () => {
      const metrics = createMetrics();

      async function logger(ctx: any, next: any) {
        await next();
        // Simulate non-trivial post-processing.
        // Use 1ms busy wait for a wide margin over the 0.01ms threshold,
        // avoiding flakiness on slower or lower-resolution environments.
        const start = performance.now();
        while (performance.now() - start < 1) {
          /* busy wait */
        }
      }

      await runWithMetrics(metrics, () =>
        executeMiddleware(
          [createMockEntry(logger)],
          new Request("http://localhost/test"),
          {},
          {},
          async () => new Response("OK"),
        ),
      );

      const pre = metrics.metrics.find(
        (m) => m.label === "middleware:logger@*:pre",
      );
      const post = metrics.metrics.find(
        (m) => m.label === "middleware:logger@*:post",
      );
      expect(pre).toBeDefined();
      expect(post).toBeDefined();
      expect(post!.duration).toBeGreaterThan(0);
    });

    it("should not record post-phase for short-circuit middleware", async () => {
      const metrics = createMetrics();

      async function guard() {
        return new Response("Blocked", { status: 403 });
      }

      await runWithMetrics(metrics, () =>
        executeMiddleware(
          [createMockEntry(guard)],
          new Request("http://localhost/test"),
          {},
          {},
          async () => new Response("OK"),
        ),
      );

      const post = metrics.metrics.find((m) => m.label.includes(":post"));
      expect(post).toBeUndefined();
    });

    it("should allow ctx.headers access after next()", async () => {
      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        await next();
        ctx.headers.set("X-Via-Ctx", "yes");
        // No return - forgiving API
      };

      const response = await executeMiddleware(
        [createMockEntry(middleware)],
        new Request("http://localhost/test"),
        {},
        {},
        async () => new Response("OK"),
      );

      expect(response.headers.get("X-Via-Ctx")).toBe("yes");
    });

    it("should allow ctx.header() shorthand", async () => {
      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        await next();
        ctx.header("X-Shorthand", "works");
      };

      const response = await executeMiddleware(
        [createMockEntry(middleware)],
        new Request("http://localhost/test"),
        {},
        {},
        async () => new Response("OK"),
      );

      expect(response.headers.get("X-Shorthand")).toBe("works");
    });

    it("should short-circuit on early Response return", async () => {
      const handler = vi.fn();

      const middleware: MiddlewareFn<unknown> = async () => {
        return new Response("Blocked", { status: 403 });
      };

      const response = await executeMiddleware(
        [createMockEntry(middleware)],
        new Request("http://localhost/test"),
        {},
        {},
        async () => {
          handler();
          return new Response("OK");
        },
      );

      expect(response.status).toBe(403);
      expect(await response.text()).toBe("Blocked");
      expect(handler).not.toHaveBeenCalled();
    });

    it("should catch errors from handler", async () => {
      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        try {
          return await next();
        } catch (error) {
          return new Response("Error caught", { status: 500 });
        }
      };

      const response = await executeMiddleware(
        [createMockEntry(middleware)],
        new Request("http://localhost/test"),
        {},
        {},
        async () => {
          throw new Error("Handler error");
        },
      );

      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Error caught");
    });

    it("should share variables with handler via ctx.set/get", async () => {
      const variables: Record<string, any> = {};

      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        ctx.set("user", { id: "123", name: "John" });
        await next();
      };

      await executeMiddleware(
        [createMockEntry(middleware)],
        new Request("http://localhost/test"),
        {},
        variables,
        async () => new Response("OK"),
      );

      expect(variables).toEqual({ user: { id: "123", name: "John" } });
    });

    it("should read cookies from request", async () => {
      let sessionValue: string | undefined;

      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        sessionValue = cookies().get("session")?.value;
        await next();
      };

      const request = new Request("http://localhost/test", {
        headers: { Cookie: "session=abc123" },
      });

      const reqCtx = createRequestContext({
        env: {},
        request,
        url: new URL(request.url),
        variables: {},
      });

      await runWithRequestContext(reqCtx, () =>
        executeMiddleware(
          [createMockEntry(middleware)],
          request,
          {},
          {},
          async () => new Response("OK"),
        ),
      );

      expect(sessionValue).toBe("abc123");
    });

    it("should set cookies on response", async () => {
      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        cookies().set("session", "xyz789", { httpOnly: true });
        await next();
      };

      const request = new Request("http://localhost/test");
      const reqCtx = createRequestContext({
        env: {},
        request,
        url: new URL(request.url),
        variables: {},
      });

      const result = await runWithRequestContext(reqCtx, () =>
        executeMiddleware(
          [createMockEntry(middleware)],
          request,
          {},
          {},
          async () => new Response("OK"),
        ),
      );

      // Verify stub has the cookie (internal path)
      const stubCookie = reqCtx.res.headers.get("Set-Cookie");
      expect(stubCookie).toContain("session=xyz789");
      expect(stubCookie).toContain("HttpOnly");

      // Verify the returned Response has the merged cookie
      const responseCookie = result.headers.get("Set-Cookie");
      expect(responseCookie).toContain("session=xyz789");
      expect(responseCookie).toContain("HttpOnly");
    });

    it("should delete cookies", async () => {
      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        cookies().delete("session");
        await next();
      };

      const request = new Request("http://localhost/test");
      const reqCtx = createRequestContext({
        env: {},
        request,
        url: new URL(request.url),
        variables: {},
      });

      const result = await runWithRequestContext(reqCtx, () =>
        executeMiddleware(
          [createMockEntry(middleware)],
          request,
          {},
          {},
          async () => new Response("OK"),
        ),
      );

      // Verify stub has the delete cookie (internal path)
      const stubCookie = reqCtx.res.headers.get("Set-Cookie");
      expect(stubCookie).toContain("session=");
      expect(stubCookie).toContain("Max-Age=0");

      // Verify the returned Response has the merged delete cookie
      const responseCookie = result.headers.get("Set-Cookie");
      expect(responseCookie).toContain("session=");
      expect(responseCookie).toContain("Max-Age=0");
    });

    it("should not duplicate Set-Cookie when cookies().set() is called before next()", async () => {
      // Regression: M1 — createResponseWithMergedHeaders inside finalHandler
      // already merges reqCtx.res Set-Cookie. executeMiddleware must not
      // append them again, which would produce duplicate Set-Cookie headers.
      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        cookies().set("token", "abc123");
        await next();
      };

      const request = new Request("http://localhost/test");
      const reqCtx = createRequestContext({
        env: {},
        request,
        url: new URL(request.url),
        variables: {},
      });

      const result = await runWithRequestContext(reqCtx, () =>
        executeMiddleware(
          [createMockEntry(middleware)],
          request,
          {},
          {},
          // finalHandler uses createResponseWithMergedHeaders (production path)
          async () =>
            createResponseWithMergedHeaders("OK", {
              status: 200,
              headers: { "content-type": "text/plain" },
            }),
        ),
      );

      // Set-Cookie should appear exactly once, not twice
      const allSetCookies = result.headers.getSetCookie();
      const tokenCookies = allSetCookies.filter((c) =>
        c.startsWith("token=abc123"),
      );
      expect(tokenCookies).toHaveLength(1);
    });

    it("should throw if middleware doesn't call next() or return", async () => {
      const middleware: MiddlewareFn<unknown> = async () => {
        // Does nothing
      };

      await expect(
        executeMiddleware(
          [createMockEntry(middleware)],
          new Request("http://localhost/test"),
          {},
          {},
          async () => new Response("OK"),
        ),
      ).rejects.toThrow("Middleware must call next()");
    });

    it("should allow setting headers before and after next() via ctx.headers", async () => {
      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        // Set header before next() using ctx.headers
        ctx.headers.set("X-Before-Next", "works");
        await next();
        // Set header after next() as well
        ctx.headers.set("X-After-Next", "also-works");
      };

      const response = await executeMiddleware(
        [createMockEntry(middleware)],
        new Request("http://localhost/test"),
        {},
        {},
        async () =>
          new Response("OK", { headers: { "X-Handler": "original" } }),
      );

      // Both headers should be present
      expect(response.headers.get("X-Before-Next")).toBe("works");
      expect(response.headers.get("X-After-Next")).toBe("also-works");
      expect(response.headers.get("X-Handler")).toBe("original");
    });

    it("should allow setting headers before next() via ctx.header()", async () => {
      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        // Set header before next() using shorthand
        ctx.header("X-Request-Id", "12345");
        await next();
      };

      const response = await executeMiddleware(
        [createMockEntry(middleware)],
        new Request("http://localhost/test"),
        {},
        {},
        async () => new Response("OK"),
      );

      expect(response.headers.get("X-Request-Id")).toBe("12345");
    });

    it("should pass params to middleware context", async () => {
      let receivedParams: Record<string, string | undefined> = {};

      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        receivedParams = ctx.params;
        await next();
      };

      await executeMiddleware(
        [
          {
            entry: {
              pattern: "/users/:id/*",
              ...parsePattern("/users/:id/*"),
              handler: middleware,
            },
            params: { id: "123" },
          },
        ],
        new Request("http://localhost/users/123/profile"),
        {},
        {},
        async () => new Response("OK"),
      );

      expect(receivedParams).toEqual({ id: "123" });
    });

    it("should warn when middleware returns non-Response value", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        await next();
        return "some string" as any; // Incorrect return type
      };

      await executeMiddleware(
        [createMockEntry(middleware)],
        new Request("http://localhost/test"),
        {},
        {},
        async () => new Response("OK"),
      );

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "returned string instead of Response or undefined",
        ),
      );

      warnSpy.mockRestore();
    });

    it("should warn about object return values", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        await next();
        return { data: "test" } as any; // Incorrect return type
      };

      await executeMiddleware(
        [createMockEntry(middleware)],
        new Request("http://localhost/test"),
        {},
        {},
        async () => new Response("OK"),
      );

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "returned object instead of Response or undefined",
        ),
      );

      warnSpy.mockRestore();
    });

    it("should merge stub headers into short-circuit Response", async () => {
      const outer: MiddlewareFn<unknown> = async (ctx, next) => {
        ctx.header("X-Before-Next", "from-outer");
        await next();
      };

      const inner: MiddlewareFn<unknown> = async () => {
        return new Response("Blocked", { status: 403 });
      };

      const result = await executeMiddleware(
        [createMockEntry(outer), createMockEntry(inner)],
        new Request("http://localhost/test"),
        {},
        {},
        async () => new Response("OK"),
      );

      expect(result.status).toBe(403);
      expect(result.headers.get("X-Before-Next")).toBe("from-outer");
    });

    it("should merge stub cookies into short-circuit Response", async () => {
      const outer: MiddlewareFn<unknown> = async (ctx, next) => {
        cookies().set("session", "abc123");
        await next();
      };

      const inner: MiddlewareFn<unknown> = async () => {
        return new Response("Blocked", { status: 403 });
      };

      const request = new Request("http://localhost/test");
      const reqCtx = createRequestContext({
        env: {},
        request,
        url: new URL(request.url),
        variables: {},
      });

      const result = await runWithRequestContext(reqCtx, () =>
        executeMiddleware(
          [createMockEntry(outer), createMockEntry(inner)],
          request,
          {},
          {},
          async () => new Response("OK"),
        ),
      );

      expect(result.status).toBe(403);
      const setCookies = result.headers.getSetCookie();
      expect(setCookies).toContain("session=abc123");
    });

    it("should not overwrite short-circuit Response's own headers with stub headers", async () => {
      const outer: MiddlewareFn<unknown> = async (ctx, next) => {
        ctx.header("Content-Type", "text/html");
        await next();
      };

      const inner: MiddlewareFn<unknown> = async () => {
        return new Response("Forbidden", {
          status: 403,
          headers: { "Content-Type": "text/plain" },
        });
      };

      const result = await executeMiddleware(
        [createMockEntry(outer), createMockEntry(inner)],
        new Request("http://localhost/test"),
        {},
        {},
        async () => new Response("OK"),
      );

      expect(result.headers.get("Content-Type")).toBe("text/plain");
    });

    // Regression: WebSocket upgrade responses (status 101, and/or Cloudflare-style
    // responses carrying a `webSocket` property) must flow back through the
    // middleware chain unchanged. The previous implementation unconditionally
    // rewrapped the handler Response with `new Response(body, { status, ... })`
    // to merge stub headers — which throws RangeError for status 101 on
    // standards-compliant runtimes and drops the non-standard `webSocket`
    // property on workerd. See: @rangojs/router upstream bug around .82–.83.
    describe("WebSocket upgrade passthrough (status 101 / webSocket)", () => {
      // Node's Response constructor rejects status outside 200–599 (RangeError),
      // so we fabricate an upgrade-style Response by overriding `.status` on a
      // real Response instance. This mirrors what workerd yields for a real WS
      // upgrade while keeping the test runnable in Node/vitest.
      const fabricateUpgradeResponse = (opts?: {
        status101?: boolean;
        webSocket?: boolean;
      }): Response => {
        const response = new Response(null, { status: 200 });
        if (opts?.status101 ?? true) {
          Object.defineProperty(response, "status", {
            value: 101,
            configurable: true,
          });
        }
        if (opts?.webSocket) {
          Object.defineProperty(response, "webSocket", {
            value: { stub: "websocket" },
            configurable: true,
            enumerable: true,
            writable: true,
          });
        }
        return response;
      };

      it("passes through status-101 handler response unchanged when middleware awaits next()", async () => {
        const upgrade = fabricateUpgradeResponse();
        const mw: MiddlewareFn<unknown> = async (_ctx, next) => {
          await next();
        };

        const result = await executeMiddleware(
          [createMockEntry(mw)],
          new Request("http://localhost/ws", {
            headers: { upgrade: "websocket", connection: "Upgrade" },
          }),
          {},
          {},
          async () => upgrade,
        );

        expect(result).toBe(upgrade);
        expect(result.status).toBe(101);
      });

      it("preserves webSocket property on handler response when middleware awaits next()", async () => {
        const upgrade = fabricateUpgradeResponse({
          status101: false,
          webSocket: true,
        });
        const mw: MiddlewareFn<unknown> = async (_ctx, next) => {
          await next();
        };

        const result = await executeMiddleware(
          [createMockEntry(mw)],
          new Request("http://localhost/ws"),
          {},
          {},
          async () => upgrade,
        );

        expect(result).toBe(upgrade);
        expect((result as unknown as { webSocket?: unknown }).webSocket).toBe(
          (upgrade as unknown as { webSocket?: unknown }).webSocket,
        );
      });

      it("passes through status-101 response returned directly by middleware (short-circuit)", async () => {
        const upgrade = fabricateUpgradeResponse();
        const mw: MiddlewareFn<unknown> = async () => upgrade;
        const finalHandler = vi.fn(async () => new Response("should not run"));

        const result = await executeMiddleware(
          [createMockEntry(mw)],
          new Request("http://localhost/ws"),
          {},
          {},
          finalHandler,
        );

        expect(result).toBe(upgrade);
        expect(result.status).toBe(101);
        expect(finalHandler).not.toHaveBeenCalled();
      });

      it("preserves webSocket property on middleware short-circuit Response", async () => {
        const upgrade = fabricateUpgradeResponse({
          status101: false,
          webSocket: true,
        });
        const mw: MiddlewareFn<unknown> = async () => upgrade;

        const result = await executeMiddleware(
          [createMockEntry(mw)],
          new Request("http://localhost/ws"),
          {},
          {},
          async () => new Response("not reached"),
        );

        expect(result).toBe(upgrade);
        expect((result as unknown as { webSocket?: unknown }).webSocket).toBe(
          (upgrade as unknown as { webSocket?: unknown }).webSocket,
        );
      });

      it("does not attempt header merge on final re-merge when handler returns 101 and middleware set stub cookies", async () => {
        const upgrade = fabricateUpgradeResponse();
        const request = new Request("http://localhost/ws");
        const reqCtx = createRequestContext({
          env: {},
          request,
          url: new URL(request.url),
          variables: {},
        });

        const mw: MiddlewareFn<unknown> = async (_ctx, next) => {
          // Write to the stub via cookies().set — the final re-merge would
          // otherwise try to mutate the upgrade response's headers, which is
          // meaningless (and can throw on runtimes where upgrade headers are
          // immutable).
          cookies().set("session", "abc123");
          return next();
        };

        const result = await runWithRequestContext(reqCtx, () =>
          executeMiddleware(
            [createMockEntry(mw)],
            request,
            {},
            {},
            async () => upgrade,
          ),
        );

        expect(result).toBe(upgrade);
        expect(result.status).toBe(101);
        // Set-Cookie must NOT have been appended to the upgrade response.
        expect(result.headers.getSetCookie()).toEqual([]);
      });

      it("does not throw RangeError when terminal-next rewrap would reject status 101", async () => {
        // Explicit regression for the original symptom:
        //   RangeError: Responses may only be constructed with status codes
        //   in the range 200 to 599, inclusive.
        const upgrade = fabricateUpgradeResponse();
        const mw: MiddlewareFn<unknown> = async (_ctx, next) => next();

        await expect(
          executeMiddleware(
            [createMockEntry(mw)],
            new Request("http://localhost/ws"),
            {},
            {},
            async () => upgrade,
          ),
        ).resolves.toBe(upgrade);
      });
    });
  });

  describe("collectRouteMiddleware", () => {
    const mw1: MiddlewareFn<unknown> = async (ctx, next) => {
      await next();
    };
    const mw2: MiddlewareFn<unknown> = async (ctx, next) => {
      await next();
    };
    const mw3: MiddlewareFn<unknown> = async (ctx, next) => {
      await next();
    };
    const mw4: MiddlewareFn<unknown> = async (ctx, next) => {
      await next();
    };

    it("should return empty array for empty entries", () => {
      const result = collectRouteMiddleware([], { id: "123" });
      expect(result).toEqual([]);
    });

    it("should return empty array for entries with no middleware", () => {
      const entries: MiddlewareCollectableEntry[] = [
        { middleware: [], layout: [] },
        { middleware: undefined, layout: undefined },
      ];
      const result = collectRouteMiddleware(entries, { id: "123" });
      expect(result).toEqual([]);
    });

    it("should collect middleware from a single entry", () => {
      const entries: MiddlewareCollectableEntry[] = [
        { middleware: [mw1, mw2] },
      ];
      const params = { id: "123" };

      const result = collectRouteMiddleware(entries, params);

      expect(result).toHaveLength(2);
      expect(result[0].handler).toBe(mw1);
      expect(result[0].params).toBe(params);
      expect(result[1].handler).toBe(mw2);
      expect(result[1].params).toBe(params);
    });

    it("should collect middleware from multiple entries in order", () => {
      const entries: MiddlewareCollectableEntry[] = [
        { middleware: [mw1] },
        { middleware: [mw2, mw3] },
      ];
      const params = { slug: "test" };

      const result = collectRouteMiddleware(entries, params);

      expect(result).toHaveLength(3);
      expect(result[0].handler).toBe(mw1);
      expect(result[1].handler).toBe(mw2);
      expect(result[2].handler).toBe(mw3);
      // All should share the same params reference
      expect(result.every((r) => r.params === params)).toBe(true);
    });

    it("should collect middleware from orphan layouts (recursive)", () => {
      const orphan1: MiddlewareCollectableEntry = { middleware: [mw3] };
      const orphan2: MiddlewareCollectableEntry = { middleware: [mw4] };
      const entries: MiddlewareCollectableEntry[] = [
        { middleware: [mw1, mw2], layout: [orphan1, orphan2] },
      ];
      const params = { id: "456" };

      const result = collectRouteMiddleware(entries, params);

      expect(result).toHaveLength(4);
      expect(result[0].handler).toBe(mw1);
      expect(result[1].handler).toBe(mw2);
      expect(result[2].handler).toBe(mw3);
      expect(result[3].handler).toBe(mw4);
    });

    it("should collect middleware from deeply nested orphan layouts", () => {
      const deepOrphan: MiddlewareCollectableEntry = { middleware: [mw4] };
      const orphan: MiddlewareCollectableEntry = {
        middleware: [mw3],
        layout: [deepOrphan],
      };
      const entries: MiddlewareCollectableEntry[] = [
        { middleware: [mw1], layout: [orphan] },
      ];
      const params = {};

      const result = collectRouteMiddleware(entries, params);

      expect(result).toHaveLength(3);
      expect(result[0].handler).toBe(mw1);
      expect(result[1].handler).toBe(mw3);
      expect(result[2].handler).toBe(mw4);
    });

    it("should handle entries with only orphan layouts (no direct middleware)", () => {
      const orphan: MiddlewareCollectableEntry = { middleware: [mw1, mw2] };
      const entries: MiddlewareCollectableEntry[] = [{ layout: [orphan] }];
      const params = { page: "1" };

      const result = collectRouteMiddleware(entries, params);

      expect(result).toHaveLength(2);
      expect(result[0].handler).toBe(mw1);
      expect(result[1].handler).toBe(mw2);
    });

    it("should work with iterable (generator) input", () => {
      function* generateEntries(): Generator<MiddlewareCollectableEntry> {
        yield { middleware: [mw1] };
        yield { middleware: [mw2] };
      }

      const result = collectRouteMiddleware(generateEntries(), { id: "gen" });

      expect(result).toHaveLength(2);
      expect(result[0].handler).toBe(mw1);
      expect(result[1].handler).toBe(mw2);
    });

    it("should preserve params reference across all collected middleware", () => {
      const orphan: MiddlewareCollectableEntry = { middleware: [mw3] };
      const entries: MiddlewareCollectableEntry[] = [
        { middleware: [mw1], layout: [orphan] },
        { middleware: [mw2] },
      ];
      const params = { shared: "value" };

      const result = collectRouteMiddleware(entries, params);

      // All middleware entries should have the exact same params object
      expect(result).toHaveLength(3);
      result.forEach((r) => {
        expect(r.params).toBe(params);
      });
    });
  });

  describe("executeInterceptMiddleware", () => {
    it("should return null for empty middleware array", async () => {
      const stubResponse = new Response(null, { status: 200 });
      const result = await executeInterceptMiddleware(
        [],
        new Request("http://localhost/test"),
        {},
        {},
        {},
        stubResponse,
      );
      expect(result).toBeNull();
    });

    it("should return null when middleware calls next() without returning Response", async () => {
      const stubResponse = new Response(null, { status: 200 });
      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        await next();
      };

      const result = await executeInterceptMiddleware(
        [middleware],
        new Request("http://localhost/test"),
        {},
        { id: "123" },
        {},
        stubResponse,
      );

      expect(result).toBeNull();
    });

    it("should return Response when middleware short-circuits", async () => {
      const stubResponse = new Response(null, { status: 200 });
      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        return new Response("Blocked", { status: 403 });
      };

      const result = await executeInterceptMiddleware(
        [middleware],
        new Request("http://localhost/test"),
        {},
        {},
        {},
        stubResponse,
      );

      expect(result).toBeInstanceOf(Response);
      expect(result!.status).toBe(403);
      expect(await result!.text()).toBe("Blocked");
    });

    it("opens a rango.middleware span per intercept middleware when tracing is on", async () => {
      // Intercept middleware previously ran un-instrumented (no span). It now
      // emits rango.middleware (span-only, metric:false) like the main chain, so
      // an intercept's middleware shows up in the trace waterfall under the
      // render phase it runs inside.
      const { spans, tracing } = recordingTracing();
      const request = new Request("http://localhost/test");
      const reqCtx = createRequestContext({
        env: {},
        request,
        url: new URL(request.url),
        variables: {},
      });
      reqCtx._tracing = tracing;
      const stubResponse = reqCtx.res;

      const middleware: MiddlewareFn<unknown> = async (_ctx, next) => {
        await next();
      };

      await runWithRequestContext(reqCtx, () =>
        executeInterceptMiddleware(
          [middleware],
          request,
          {},
          {},
          {},
          stubResponse,
        ),
      );

      expect(spans).toContain("rango.middleware");
    });

    it("should apply cookies to short-circuit Response", async () => {
      const request = new Request("http://localhost/test");
      const reqCtx = createRequestContext({
        env: {},
        request,
        url: new URL(request.url),
        variables: {},
      });
      const stubResponse = reqCtx.res;

      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        cookies().set("session", "abc123", { path: "/" });
        return new Response("Redirecting", { status: 302 });
      };

      const result = await runWithRequestContext(reqCtx, () =>
        executeInterceptMiddleware(
          [middleware],
          request,
          {},
          {},
          {},
          stubResponse,
        ),
      );

      expect(result).toBeInstanceOf(Response);
      const setCookies = result!.headers.get("set-cookie");
      expect(setCookies).toContain("session=abc123");
      expect(setCookies).toContain("Path=/");
    });

    it("should apply multiple cookies to short-circuit Response", async () => {
      const request = new Request("http://localhost/test");
      const reqCtx = createRequestContext({
        env: {},
        request,
        url: new URL(request.url),
        variables: {},
      });
      const stubResponse = reqCtx.res;

      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        cookies().set("token", "xyz", { httpOnly: true });
        cookies().set("preference", "dark");
        return new Response(null, {
          status: 302,
          headers: { Location: "/login" },
        });
      };

      const result = await runWithRequestContext(reqCtx, () =>
        executeInterceptMiddleware(
          [middleware],
          request,
          {},
          {},
          {},
          stubResponse,
        ),
      );

      expect(result).toBeInstanceOf(Response);
      const setCookies = result!.headers.getSetCookie();
      expect(setCookies).toHaveLength(2);
      expect(setCookies.some((c) => c.includes("token=xyz"))).toBe(true);
      expect(setCookies.some((c) => c.includes("preference=dark"))).toBe(true);
    });

    it("should share variables between middleware and allow setting new ones", async () => {
      const stubResponse = new Response(null, { status: 200 });
      const variables: Record<string, any> = { existing: "value" };
      let capturedVars: Record<string, any> = {};

      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        capturedVars.existing = ctx.get("existing");
        ctx.set("newVar", "newValue");
        capturedVars.newVar = ctx.get("newVar");
        await next();
      };

      await executeInterceptMiddleware(
        [middleware],
        new Request("http://localhost/test"),
        {},
        {},
        variables,
        stubResponse,
      );

      expect(capturedVars.existing).toBe("value");
      expect(capturedVars.newVar).toBe("newValue");
      expect(variables.newVar).toBe("newValue");
    });

    it("should provide params to middleware context", async () => {
      const stubResponse = new Response(null, { status: 200 });
      let capturedParams: Record<string, string | undefined> = {};

      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        capturedParams = ctx.params;
        await next();
      };

      await executeInterceptMiddleware(
        [middleware],
        new Request("http://localhost/test"),
        {},
        { id: "456", slug: "test-slug" },
        {},
        stubResponse,
      );

      expect(capturedParams).toEqual({ id: "456", slug: "test-slug" });
    });

    it("should execute multiple middleware in order", async () => {
      const stubResponse = new Response(null, { status: 200 });
      const order: number[] = [];

      const mw1: MiddlewareFn<unknown> = async (ctx, next) => {
        order.push(1);
        await next();
        order.push(4);
      };

      const mw2: MiddlewareFn<unknown> = async (ctx, next) => {
        order.push(2);
        await next();
        order.push(3);
      };

      await executeInterceptMiddleware(
        [mw1, mw2],
        new Request("http://localhost/test"),
        {},
        {},
        {},
        stubResponse,
      );

      expect(order).toEqual([1, 2, 3, 4]);
    });

    it("should stop execution when middleware returns Response", async () => {
      const stubResponse = new Response(null, { status: 200 });
      const order: number[] = [];

      const mw1: MiddlewareFn<unknown> = async (ctx, next) => {
        order.push(1);
        return new Response("Stopped at mw1", { status: 401 });
      };

      const mw2: MiddlewareFn<unknown> = async (ctx, next) => {
        order.push(2);
        await next();
      };

      const result = await executeInterceptMiddleware(
        [mw1, mw2],
        new Request("http://localhost/test"),
        {},
        {},
        {},
        stubResponse,
      );

      expect(order).toEqual([1]);
      expect(result!.status).toBe(401);
    });

    it("should allow ctx.headers access after next() without throwing", async () => {
      const stubResponse = new Response(null, { status: 200 });
      stubResponse.headers.set("X-Test", "value");
      let headerValue: string | null | undefined;

      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        await next();
        // This should not throw - ctx.headers should be accessible
        headerValue = ctx.headers.get("X-Test");
      };

      const result = await executeInterceptMiddleware(
        [middleware],
        new Request("http://localhost/test"),
        {},
        {},
        {},
        stubResponse,
      );

      expect(headerValue).toBe("value");
      expect(result).toBeNull(); // No short-circuit, no modifications
    });

    it("should NOT short-circuit when middleware uses ctx.header() after next() - headers go on stubResponse", async () => {
      const stubResponse = new Response(null, { status: 200 });
      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        await next();
        ctx.header("X-Custom-Header", "custom-value");
      };

      const result = await executeInterceptMiddleware(
        [middleware],
        new Request("http://localhost/test"),
        {},
        {},
        {},
        stubResponse,
      );

      // Should return null (no short-circuit) - headers are on stubResponse for caller to merge
      expect(result).toBeNull();
      expect(stubResponse.headers.get("X-Custom-Header")).toBe("custom-value");
    });

    it("should NOT short-circuit when cookies set after next() - cookies go on stubResponse", async () => {
      const request = new Request("http://localhost/test");
      const reqCtx = createRequestContext({
        env: {},
        request,
        url: new URL(request.url),
        variables: {},
      });
      const stubResponse = reqCtx.res;

      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        await next();
        ctx.header("X-Modified", "true");
        cookies().set("after-next", "cookie-value");
      };

      const result = await runWithRequestContext(reqCtx, () =>
        executeInterceptMiddleware(
          [middleware],
          request,
          {},
          {},
          {},
          stubResponse,
        ),
      );

      // Should return null (no short-circuit) - headers/cookies are on stubResponse
      expect(result).toBeNull();
      expect(stubResponse.headers.get("X-Modified")).toBe("true");
      const setCookies = stubResponse.headers.get("set-cookie");
      expect(setCookies).toContain("after-next=cookie-value");
    });

    it("should set cookies on stubResponse when only cookies are set after next()", async () => {
      const request = new Request("http://localhost/test");
      const reqCtx = createRequestContext({
        env: {},
        request,
        url: new URL(request.url),
        variables: {},
      });
      const stubResponse = reqCtx.res;

      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        await next();
        cookies().set("only-cookie", "value123");
      };

      const result = await runWithRequestContext(reqCtx, () =>
        executeInterceptMiddleware(
          [middleware],
          request,
          {},
          {},
          {},
          stubResponse,
        ),
      );

      // Should return null (no short-circuit) - cookie is on stubResponse
      expect(result).toBeNull();
      const setCookies = stubResponse.headers.get("set-cookie");
      expect(setCookies).toContain("only-cookie=value123");
    });
  });

  describe("executeLoaderMiddleware", () => {
    it("should call finalHandler directly when no middleware", async () => {
      const finalHandler = vi.fn().mockResolvedValue(new Response("Data"));

      const result = await executeLoaderMiddleware(
        [],
        new Request("http://localhost/test"),
        {},
        {},
        {},
        finalHandler,
      );

      expect(finalHandler).toHaveBeenCalled();
      expect(await result.text()).toBe("Data");
    });

    it("should execute middleware before finalHandler", async () => {
      const order: string[] = [];

      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        order.push("middleware-before");
        await next();
        order.push("middleware-after");
      };

      const finalHandler = async () => {
        order.push("handler");
        return new Response("OK");
      };

      await executeLoaderMiddleware(
        [middleware],
        new Request("http://localhost/test"),
        {},
        {},
        {},
        finalHandler,
      );

      expect(order).toEqual([
        "middleware-before",
        "handler",
        "middleware-after",
      ]);
    });

    it("should share variables with finalHandler", async () => {
      const variables: Record<string, any> = {};
      let capturedVar: any;

      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        ctx.set("userId", "user-123");
        await next();
      };

      const finalHandler = async () => {
        capturedVar = variables.userId;
        return new Response("OK");
      };

      await executeLoaderMiddleware(
        [middleware],
        new Request("http://localhost/test"),
        {},
        {},
        variables,
        finalHandler,
      );

      expect(capturedVar).toBe("user-123");
    });

    it("should provide params to middleware context", async () => {
      let capturedParams: Record<string, string | undefined> = {};

      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        capturedParams = ctx.params;
        await next();
      };

      await executeLoaderMiddleware(
        [middleware],
        new Request("http://localhost/test"),
        {},
        { loaderId: "cart", userId: "456" },
        {},
        async () => new Response("OK"),
      );

      expect(capturedParams).toEqual({ loaderId: "cart", userId: "456" });
    });

    it("should allow middleware to short-circuit with Response", async () => {
      const finalHandler = vi.fn().mockResolvedValue(new Response("Data"));

      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        return new Response("Unauthorized", { status: 401 });
      };

      const result = await executeLoaderMiddleware(
        [middleware],
        new Request("http://localhost/test"),
        {},
        {},
        {},
        finalHandler,
      );

      expect(finalHandler).not.toHaveBeenCalled();
      expect(result.status).toBe(401);
      expect(await result.text()).toBe("Unauthorized");
    });

    it("should apply cookies set by middleware", async () => {
      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        cookies().set("session", "new-session-id");
        await next();
      };

      const request = new Request("http://localhost/test");
      const reqCtx = createRequestContext({
        env: {},
        request,
        url: new URL(request.url),
        variables: {},
      });

      const result = await runWithRequestContext(reqCtx, () =>
        executeLoaderMiddleware(
          [middleware],
          request,
          {},
          {},
          {},
          async () => new Response("OK"),
        ),
      );

      // Verify stub has the cookie (internal path)
      const stubCookie = reqCtx.res.headers.get("set-cookie");
      expect(stubCookie).toContain("session=new-session-id");

      // Verify the returned Response has the merged cookie
      const responseCookie = result.headers.get("set-cookie");
      expect(responseCookie).toContain("session=new-session-id");
    });

    it("should allow middleware to modify response headers", async () => {
      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        await next();
        ctx.header("X-Loader-Cache", "HIT");
      };

      const result = await executeLoaderMiddleware(
        [middleware],
        new Request("http://localhost/test"),
        {},
        {},
        {},
        async () => new Response("OK"),
      );

      expect(result.headers.get("X-Loader-Cache")).toBe("HIT");
    });
  });

  describe("cookie response-derived delegation", () => {
    it("middleware cookies().set visible to subsequent middleware cookies().get read", async () => {
      const request = new Request("http://localhost/test", {
        headers: { Cookie: "existing=original" },
      });

      const reqCtx = createRequestContext({
        env: {},
        request,
        url: new URL(request.url),
        variables: {},
      });

      let readValue: string | undefined;

      await runWithRequestContext(reqCtx, () =>
        executeMiddleware<Record<string, unknown>>(
          [
            {
              entry: {
                pattern: null,
                regex: null,
                paramNames: [],
                handler: async (ctx, next) => {
                  cookies().set("session", "new-token");
                  return next();
                },
              },
              params: {},
            },
            {
              entry: {
                pattern: null,
                regex: null,
                paramNames: [],
                handler: async (ctx, next) => {
                  readValue = cookies().get("session")?.value;
                  return next();
                },
              },
              params: {},
            },
          ],
          request,
          {},
          {},
          async () => new Response("OK"),
        ),
      );

      expect(readValue).toBe("new-token");
    });

    it("middleware cookies().set visible to RequestContext cookie()", async () => {
      const request = new Request("http://localhost/test");

      const reqCtx = createRequestContext({
        env: {},
        request,
        url: new URL(request.url),
        variables: {},
      });

      await runWithRequestContext(reqCtx, () =>
        executeMiddleware<Record<string, unknown>>(
          [
            {
              entry: {
                pattern: null,
                regex: null,
                paramNames: [],
                handler: async (ctx, next) => {
                  cookies().set("mw-set", "hello");
                  return next();
                },
              },
              params: {},
            },
          ],
          request,
          {},
          {},
          async () => new Response("OK"),
        ),
      );

      // RequestContext should see the cookie set by middleware
      expect(reqCtx.cookie("mw-set")).toBe("hello");
    });

    it("middleware cookies().delete makes subsequent reads return undefined", async () => {
      const request = new Request("http://localhost/test", {
        headers: { Cookie: "session=old" },
      });

      const reqCtx = createRequestContext({
        env: {},
        request,
        url: new URL(request.url),
        variables: {},
      });

      let readValue: string | undefined = "sentinel";

      await runWithRequestContext(reqCtx, () =>
        executeMiddleware<Record<string, unknown>>(
          [
            {
              entry: {
                pattern: null,
                regex: null,
                paramNames: [],
                handler: async (ctx, next) => {
                  cookies().delete("session");
                  return next();
                },
              },
              params: {},
            },
            {
              entry: {
                pattern: null,
                regex: null,
                paramNames: [],
                handler: async (ctx, next) => {
                  readValue = cookies().get("session")?.value;
                  return next();
                },
              },
              params: {},
            },
          ],
          request,
          {},
          {},
          async () => new Response("OK"),
        ),
      );

      expect(readValue).toBeUndefined();
      expect(reqCtx.cookie("session")).toBeUndefined();
    });

    it("middleware cookies().set visible on ctx.headers before next()", async () => {
      const request = new Request("http://localhost/test");
      const reqCtx = createRequestContext({
        env: {},
        request,
        url: new URL(request.url),
        variables: {},
      });

      let setCookieHeaders: string[] = [];

      await runWithRequestContext(reqCtx, () =>
        executeMiddleware<Record<string, unknown>>(
          [
            {
              entry: {
                pattern: null,
                regex: null,
                paramNames: [],
                handler: async (ctx, next) => {
                  cookies().set("token", "abc123", { httpOnly: true });
                  // ctx.headers should reflect the cookie set above
                  setCookieHeaders = ctx.headers.getSetCookie();
                  return next();
                },
              },
              params: {},
            },
          ],
          request,
          {},
          {},
          async () => new Response("OK"),
        ),
      );

      expect(setCookieHeaders.length).toBe(1);
      expect(setCookieHeaders[0]).toContain("token=abc123");
      expect(setCookieHeaders[0]).toContain("HttpOnly");
    });

    it("middleware ctx.header visible on ctx.headers before next()", async () => {
      const request = new Request("http://localhost/test");
      const reqCtx = createRequestContext({
        env: {},
        request,
        url: new URL(request.url),
        variables: {},
      });

      let headerValue: string | null = null;

      await runWithRequestContext(reqCtx, () =>
        executeMiddleware<Record<string, unknown>>(
          [
            {
              entry: {
                pattern: null,
                regex: null,
                paramNames: [],
                handler: async (ctx, next) => {
                  ctx.header("X-Request-Id", "req-42");
                  headerValue = ctx.headers.get("X-Request-Id");
                  return next();
                },
              },
              params: {},
            },
          ],
          request,
          {},
          {},
          async () => new Response("OK"),
        ),
      );

      expect(headerValue).toBe("req-42");
    });

    it("cookies() reads request cookies within request context", async () => {
      const request = new Request("http://localhost/test", {
        headers: { Cookie: "fallback=works" },
      });

      const reqCtx = createRequestContext({
        env: {},
        request,
        url: new URL(request.url),
        variables: {},
      });

      let readValue: string | undefined;

      await runWithRequestContext(reqCtx, () =>
        executeMiddleware<Record<string, unknown>>(
          [
            {
              entry: {
                pattern: null,
                regex: null,
                paramNames: [],
                handler: async (ctx, next) => {
                  readValue = cookies().get("fallback")?.value;
                  return next();
                },
              },
              params: {},
            },
          ],
          request,
          {},
          {},
          async () => new Response("OK"),
        ),
      );

      expect(readValue).toBe("works");
    });
  });
});
