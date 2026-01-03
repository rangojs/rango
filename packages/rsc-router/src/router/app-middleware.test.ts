import { describe, it, expect, vi } from "vitest";
import {
  parsePattern,
  extractParams,
  parseCookies,
  serializeCookie,
  matchMiddleware,
  executeAppMiddleware,
  type AppMiddlewareFn,
  type AppMiddlewareEntry,
} from "./app-middleware";

describe("app-middleware", () => {
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
      const { regex, paramNames } = parsePattern("/users/:userId/posts/:postId");
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
      const { regex, paramNames } = parsePattern("/users/:userId/posts/:postId");
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
      const entries: AppMiddlewareEntry<unknown>[] = [
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
      const entries: AppMiddlewareEntry<unknown>[] = [
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
      const entries: AppMiddlewareEntry<unknown>[] = [
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
      const entries: AppMiddlewareEntry<unknown>[] = [
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

  describe("executeAppMiddleware", () => {
    const createMockEntry = (
      handler: AppMiddlewareFn<unknown>
    ): { entry: AppMiddlewareEntry<unknown>; params: Record<string, string> } => ({
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
      const middleware: AppMiddlewareFn<unknown> = async (ctx, next) => {
        const response = await next();
        response.headers.set("X-Test", "value");
        return response;
      };

      const response = await executeAppMiddleware(
        [createMockEntry(middleware)],
        new Request("http://localhost/test"),
        {},
        {},
        async () => new Response("OK")
      );

      expect(response.headers.get("X-Test")).toBe("value");
      expect(await response.text()).toBe("OK");
    });

    it("should execute middleware in order", async () => {
      const order: number[] = [];

      const mw1: AppMiddlewareFn<unknown> = async (ctx, next) => {
        order.push(1);
        await next();
        order.push(4);
      };

      const mw2: AppMiddlewareFn<unknown> = async (ctx, next) => {
        order.push(2);
        await next();
        order.push(3);
      };

      await executeAppMiddleware(
        [createMockEntry(mw1), createMockEntry(mw2)],
        new Request("http://localhost/test"),
        {},
        {},
        async () => new Response("OK")
      );

      expect(order).toEqual([1, 2, 3, 4]);
    });

    it("should allow ctx.res access after next()", async () => {
      const middleware: AppMiddlewareFn<unknown> = async (ctx, next) => {
        await next();
        ctx.res.headers.set("X-Via-Ctx", "yes");
        // No return - forgiving API
      };

      const response = await executeAppMiddleware(
        [createMockEntry(middleware)],
        new Request("http://localhost/test"),
        {},
        {},
        async () => new Response("OK")
      );

      expect(response.headers.get("X-Via-Ctx")).toBe("yes");
    });

    it("should allow ctx.header() shorthand", async () => {
      const middleware: AppMiddlewareFn<unknown> = async (ctx, next) => {
        await next();
        ctx.header("X-Shorthand", "works");
      };

      const response = await executeAppMiddleware(
        [createMockEntry(middleware)],
        new Request("http://localhost/test"),
        {},
        {},
        async () => new Response("OK")
      );

      expect(response.headers.get("X-Shorthand")).toBe("works");
    });

    it("should short-circuit on early Response return", async () => {
      const handler = vi.fn();

      const middleware: AppMiddlewareFn<unknown> = async () => {
        return new Response("Blocked", { status: 403 });
      };

      const response = await executeAppMiddleware(
        [createMockEntry(middleware)],
        new Request("http://localhost/test"),
        {},
        {},
        async () => {
          handler();
          return new Response("OK");
        }
      );

      expect(response.status).toBe(403);
      expect(await response.text()).toBe("Blocked");
      expect(handler).not.toHaveBeenCalled();
    });

    it("should catch errors from handler", async () => {
      const middleware: AppMiddlewareFn<unknown> = async (ctx, next) => {
        try {
          return await next();
        } catch (error) {
          return new Response("Error caught", { status: 500 });
        }
      };

      const response = await executeAppMiddleware(
        [createMockEntry(middleware)],
        new Request("http://localhost/test"),
        {},
        {},
        async () => {
          throw new Error("Handler error");
        }
      );

      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Error caught");
    });

    it("should share variables with handler via ctx.set/get", async () => {
      const variables: Record<string, any> = {};

      const middleware: AppMiddlewareFn<unknown> = async (ctx, next) => {
        ctx.set("user", { id: "123", name: "John" });
        await next();
      };

      await executeAppMiddleware(
        [createMockEntry(middleware)],
        new Request("http://localhost/test"),
        {},
        variables,
        async () => new Response("OK")
      );

      expect(variables).toEqual({ user: { id: "123", name: "John" } });
    });

    it("should read cookies from request", async () => {
      let sessionValue: string | undefined;

      const middleware: AppMiddlewareFn<unknown> = async (ctx, next) => {
        sessionValue = ctx.cookie("session");
        await next();
      };

      const request = new Request("http://localhost/test", {
        headers: { Cookie: "session=abc123" },
      });

      await executeAppMiddleware(
        [createMockEntry(middleware)],
        request,
        {},
        {},
        async () => new Response("OK")
      );

      expect(sessionValue).toBe("abc123");
    });

    it("should set cookies on response", async () => {
      const middleware: AppMiddlewareFn<unknown> = async (ctx, next) => {
        ctx.setCookie("session", "xyz789", { httpOnly: true });
        await next();
      };

      const response = await executeAppMiddleware(
        [createMockEntry(middleware)],
        new Request("http://localhost/test"),
        {},
        {},
        async () => new Response("OK")
      );

      const setCookie = response.headers.get("Set-Cookie");
      expect(setCookie).toContain("session=xyz789");
      expect(setCookie).toContain("HttpOnly");
    });

    it("should delete cookies", async () => {
      const middleware: AppMiddlewareFn<unknown> = async (ctx, next) => {
        ctx.deleteCookie("session");
        await next();
      };

      const response = await executeAppMiddleware(
        [createMockEntry(middleware)],
        new Request("http://localhost/test"),
        {},
        {},
        async () => new Response("OK")
      );

      const setCookie = response.headers.get("Set-Cookie");
      expect(setCookie).toContain("session=");
      expect(setCookie).toContain("Max-Age=0");
    });

    it("should throw if middleware doesn't call next() or return", async () => {
      const middleware: AppMiddlewareFn<unknown> = async () => {
        // Does nothing
      };

      await expect(
        executeAppMiddleware(
          [createMockEntry(middleware)],
          new Request("http://localhost/test"),
          {},
          {},
          async () => new Response("OK")
        )
      ).rejects.toThrow("Middleware must call next()");
    });

    it("should throw if ctx.res accessed before next()", async () => {
      const middleware: AppMiddlewareFn<unknown> = async (ctx) => {
        // Try to access res before next()
        ctx.res.headers.set("X-Test", "value");
      };

      await expect(
        executeAppMiddleware(
          [createMockEntry(middleware)],
          new Request("http://localhost/test"),
          {},
          {},
          async () => new Response("OK")
        )
      ).rejects.toThrow("ctx.res is not available until after await next()");
    });

    it("should pass params to middleware context", async () => {
      let receivedParams: Record<string, string> = {};

      const middleware: AppMiddlewareFn<unknown> = async (ctx, next) => {
        receivedParams = ctx.params;
        await next();
      };

      await executeAppMiddleware(
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
        async () => new Response("OK")
      );

      expect(receivedParams).toEqual({ id: "123" });
    });

    it("should allow middleware to replace response via ctx.res setter", async () => {
      const middleware: AppMiddlewareFn<unknown> = async (ctx, next) => {
        await next();
        ctx.res = new Response("Replaced", { status: 201 });
      };

      const response = await executeAppMiddleware(
        [createMockEntry(middleware)],
        new Request("http://localhost/test"),
        {},
        {},
        async () => new Response("Original")
      );

      expect(response.status).toBe(201);
      expect(await response.text()).toBe("Replaced");
    });
  });
});
