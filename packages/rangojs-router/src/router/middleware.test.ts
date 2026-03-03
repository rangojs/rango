import { describe, it, expect, vi } from "vitest";
import {
  parsePattern,
  extractParams,
  parseCookies,
  serializeCookie,
  matchMiddleware,
  executeMiddleware,
  executeInterceptMiddleware,
  executeLoaderMiddleware,
  collectRouteMiddleware,
  type MiddlewareFn,
  type MiddlewareEntry,
  type MiddlewareCollectableEntry,
} from "./middleware";

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
          mountPrefix: null,
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
          mountPrefix: null,
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
          mountPrefix: null,
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
          mountPrefix: null,
        },
        {
          pattern: "/admin/*",
          ...parsePattern("/admin/*"),
          handler: vi.fn(),
          mountPrefix: null,
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
        mountPrefix: null,
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

    it("should allow ctx.res access after next()", async () => {
      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        await next();
        ctx.res.headers.set("X-Via-Ctx", "yes");
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
        sessionValue = ctx.cookie("session");
        await next();
      };

      const request = new Request("http://localhost/test", {
        headers: { Cookie: "session=abc123" },
      });

      await executeMiddleware(
        [createMockEntry(middleware)],
        request,
        {},
        {},
        async () => new Response("OK"),
      );

      expect(sessionValue).toBe("abc123");
    });

    it("should set cookies on response", async () => {
      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        ctx.setCookie("session", "xyz789", { httpOnly: true });
        await next();
      };

      const response = await executeMiddleware(
        [createMockEntry(middleware)],
        new Request("http://localhost/test"),
        {},
        {},
        async () => new Response("OK"),
      );

      const setCookie = response.headers.get("Set-Cookie");
      expect(setCookie).toContain("session=xyz789");
      expect(setCookie).toContain("HttpOnly");
    });

    it("should delete cookies", async () => {
      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        ctx.deleteCookie("session");
        await next();
      };

      const response = await executeMiddleware(
        [createMockEntry(middleware)],
        new Request("http://localhost/test"),
        {},
        {},
        async () => new Response("OK"),
      );

      const setCookie = response.headers.get("Set-Cookie");
      expect(setCookie).toContain("session=");
      expect(setCookie).toContain("Max-Age=0");
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

    it("should allow setting headers before next() via ctx.res", async () => {
      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        // Set header before next() using stub response
        ctx.res.headers.set("X-Before-Next", "works");
        await next();
        // Set header after next() as well
        ctx.res.headers.set("X-After-Next", "also-works");
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
      let receivedParams: Record<string, string> = {};

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
              mountPrefix: null,
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

    it("should allow middleware to replace response via ctx.res setter", async () => {
      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        await next();
        ctx.res = new Response("Replaced", { status: 201 });
      };

      const response = await executeMiddleware(
        [createMockEntry(middleware)],
        new Request("http://localhost/test"),
        {},
        {},
        async () => new Response("Original"),
      );

      expect(response.status).toBe(201);
      expect(await response.text()).toBe("Replaced");
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
        ctx.setCookie("session", "abc123");
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
      const cookies = result.headers.getSetCookie();
      expect(cookies).toContain("session=abc123");
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

    it("should apply cookies to short-circuit Response", async () => {
      const stubResponse = new Response(null, { status: 200 });
      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        ctx.setCookie("session", "abc123", { path: "/" });
        return new Response("Redirecting", { status: 302 });
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
      const cookies = result!.headers.get("set-cookie");
      expect(cookies).toContain("session=abc123");
      expect(cookies).toContain("Path=/");
    });

    it("should apply multiple cookies to short-circuit Response", async () => {
      const stubResponse = new Response(null, { status: 200 });
      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        ctx.setCookie("token", "xyz", { httpOnly: true });
        ctx.setCookie("preference", "dark");
        return new Response(null, {
          status: 302,
          headers: { Location: "/login" },
        });
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
      const cookies = result!.headers.getSetCookie();
      expect(cookies).toHaveLength(2);
      expect(cookies.some((c) => c.includes("token=xyz"))).toBe(true);
      expect(cookies.some((c) => c.includes("preference=dark"))).toBe(true);
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
      let capturedParams: Record<string, string> = {};

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

    it("should allow ctx.res access after next() without throwing", async () => {
      const stubResponse = new Response(null, { status: 200 });
      let resStatus: number | undefined;

      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        await next();
        // This should not throw - ctx.res should be accessible
        resStatus = ctx.res.status;
      };

      const result = await executeInterceptMiddleware(
        [middleware],
        new Request("http://localhost/test"),
        {},
        {},
        {},
        stubResponse,
      );

      expect(resStatus).toBe(200);
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

    it("should short-circuit when middleware replaces ctx.res after next()", async () => {
      const stubResponse = new Response(null, { status: 200 });
      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        await next();
        ctx.res = new Response("Custom body", { status: 201 });
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
      expect(result!.status).toBe(201);
      expect(await result!.text()).toBe("Custom body");
    });

    it("should NOT short-circuit when cookies set after next() - cookies go on stubResponse", async () => {
      const stubResponse = new Response(null, { status: 200 });
      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        await next();
        ctx.header("X-Modified", "true");
        ctx.setCookie("after-next", "cookie-value");
      };

      const result = await executeInterceptMiddleware(
        [middleware],
        new Request("http://localhost/test"),
        {},
        {},
        {},
        stubResponse,
      );

      // Should return null (no short-circuit) - headers/cookies are on stubResponse
      expect(result).toBeNull();
      expect(stubResponse.headers.get("X-Modified")).toBe("true");
      const cookies = stubResponse.headers.get("set-cookie");
      expect(cookies).toContain("after-next=cookie-value");
    });

    it("should set cookies on stubResponse when only cookies are set after next()", async () => {
      const stubResponse = new Response(null, { status: 200 });
      const middleware: MiddlewareFn<unknown> = async (ctx, next) => {
        await next();
        ctx.setCookie("only-cookie", "value123");
      };

      const result = await executeInterceptMiddleware(
        [middleware],
        new Request("http://localhost/test"),
        {},
        {},
        {},
        stubResponse,
      );

      // Should return null (no short-circuit) - cookie is on stubResponse
      expect(result).toBeNull();
      const cookies = stubResponse.headers.get("set-cookie");
      expect(cookies).toContain("only-cookie=value123");
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
      let capturedParams: Record<string, string> = {};

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
        ctx.setCookie("session", "new-session-id");
        await next();
      };

      const result = await executeLoaderMiddleware(
        [middleware],
        new Request("http://localhost/test"),
        {},
        {},
        {},
        async () => new Response("OK"),
      );

      const cookies = result.headers.get("set-cookie");
      expect(cookies).toContain("session=new-session-id");
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
});
