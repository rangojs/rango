import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executeMiddleware } from "../middleware";
import type { HandlerContext, MiddlewareFn } from "../../types";

// Mock the track function from server/context
vi.mock("../../server/context", () => ({
  track: vi.fn(() => vi.fn()),
}));

// Helper to create a minimal handler context
const createContext = (): HandlerContext<any, any> => ({
  params: {},
  request: new Request("http://localhost/"),
  searchParams: new URLSearchParams(),
  pathname: "/",
  url: new URL("http://localhost/"),
  env: {},
  var: {},
  get: vi.fn(),
  set: vi.fn(),
  _originalRequest: new Request("http://localhost/"),
  use: () => {
    throw new Error("not implemented");
  },
});

describe("executeMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("empty middleware chain", () => {
    it("should return null for empty middleware array", async () => {
      const ctx = createContext();
      const result = await executeMiddleware([], ctx);
      expect(result).toBeNull();
    });
  });

  describe("middleware execution order", () => {
    it("should execute middleware in order", async () => {
      const order: number[] = [];
      const ctx = createContext();

      const mw1: MiddlewareFn = async (_ctx, next) => {
        order.push(1);
        await next();
      };

      const mw2: MiddlewareFn = async (_ctx, next) => {
        order.push(2);
        await next();
      };

      const mw3: MiddlewareFn = async (_ctx, next) => {
        order.push(3);
        await next();
      };

      await executeMiddleware([mw1, mw2, mw3], ctx);

      expect(order).toEqual([1, 2, 3]);
    });

    it("should pass context to each middleware", async () => {
      const ctx = createContext();
      ctx.set = vi.fn();

      const mw1: MiddlewareFn = async (c, next) => {
        c.set("step1", true);
        await next();
      };

      const mw2: MiddlewareFn = async (c, next) => {
        c.set("step2", true);
        await next();
      };

      await executeMiddleware([mw1, mw2], ctx);

      expect(ctx.set).toHaveBeenCalledWith("step1", true);
      expect(ctx.set).toHaveBeenCalledWith("step2", true);
    });
  });

  describe("middleware short-circuiting", () => {
    it("should return Response when middleware returns Response", async () => {
      const ctx = createContext();
      const response = new Response("Unauthorized", { status: 401 });

      const authMiddleware: MiddlewareFn = async () => {
        return response;
      };

      const result = await executeMiddleware([authMiddleware], ctx);

      expect(result).toBe(response);
    });

    it("should stop chain when middleware returns Response", async () => {
      const ctx = createContext();
      const afterAuth = vi.fn();

      const authMiddleware: MiddlewareFn = async () => {
        return new Response("Unauthorized", { status: 401 });
      };

      const nextMiddleware: MiddlewareFn = async (_ctx, next) => {
        afterAuth();
        await next();
      };

      await executeMiddleware([authMiddleware, nextMiddleware], ctx);

      expect(afterAuth).not.toHaveBeenCalled();
    });

    it("should stop chain when nested middleware returns Response", async () => {
      const ctx = createContext();
      const order: string[] = [];

      const mw1: MiddlewareFn = async (_ctx, next) => {
        order.push("mw1-before");
        await next();
        order.push("mw1-after");
      };

      const mw2: MiddlewareFn = async () => {
        order.push("mw2-response");
        return new Response("Stop here", { status: 200 });
      };

      const mw3: MiddlewareFn = async (_ctx, next) => {
        order.push("mw3");
        await next();
      };

      const result = await executeMiddleware([mw1, mw2, mw3], ctx);

      expect(result).toBeInstanceOf(Response);
      // mw3 should NOT be called (chain stopped)
      expect(order).not.toContain("mw3");
      // mw1-after WILL be called (middleware continues after await next())
      // This is correct behavior - Response short-circuits future calls, not already-running middleware
      expect(order).toEqual(["mw1-before", "mw2-response", "mw1-after"]);
    });
  });

  describe("middleware next() behavior", () => {
    it("should allow middleware to run code after next()", async () => {
      const ctx = createContext();
      const order: string[] = [];

      const mw1: MiddlewareFn = async (_ctx, next) => {
        order.push("mw1-before");
        await next();
        order.push("mw1-after");
      };

      const mw2: MiddlewareFn = async (_ctx, next) => {
        order.push("mw2-before");
        await next();
        order.push("mw2-after");
      };

      await executeMiddleware([mw1, mw2], ctx);

      expect(order).toEqual([
        "mw1-before",
        "mw2-before",
        "mw2-after",
        "mw1-after",
      ]);
    });

    it("should handle middleware that does not call next()", async () => {
      const ctx = createContext();
      const mw2Called = vi.fn();

      const mw1: MiddlewareFn = async () => {
        // Does not call next() - stops the chain
      };

      const mw2: MiddlewareFn = async (_ctx, next) => {
        mw2Called();
        await next();
      };

      const result = await executeMiddleware([mw1, mw2], ctx);

      expect(result).toBeNull();
      expect(mw2Called).not.toHaveBeenCalled();
    });

    it("should handle multiple next() calls gracefully", async () => {
      const ctx = createContext();
      const order: number[] = [];

      const mw1: MiddlewareFn = async (_ctx, next) => {
        order.push(1);
        await next();
        await next(); // Second call should be no-op
        order.push(2);
      };

      const mw2: MiddlewareFn = async (_ctx, next) => {
        order.push(3);
        await next();
      };

      await executeMiddleware([mw1, mw2], ctx);

      // Second next() should not re-run mw2
      expect(order).toEqual([1, 3, 2]);
    });
  });

  describe("error handling", () => {
    it("should propagate errors thrown by middleware", async () => {
      const ctx = createContext();

      const errorMiddleware: MiddlewareFn = async () => {
        throw new Error("Middleware error");
      };

      await expect(executeMiddleware([errorMiddleware], ctx)).rejects.toThrow(
        "Middleware error"
      );
    });

    it("should propagate errors from nested middleware", async () => {
      const ctx = createContext();

      const mw1: MiddlewareFn = async (_ctx, next) => {
        await next();
      };

      const mw2: MiddlewareFn = async () => {
        throw new Error("Nested error");
      };

      await expect(executeMiddleware([mw1, mw2], ctx)).rejects.toThrow(
        "Nested error"
      );
    });

    it("should allow try/catch in middleware", async () => {
      const ctx = createContext();
      let caughtError: Error | null = null;

      const errorHandler: MiddlewareFn = async (_ctx, next) => {
        try {
          await next();
        } catch (error) {
          caughtError = error as Error;
          // Don't rethrow - handle the error
        }
      };

      const errorThrower: MiddlewareFn = async () => {
        throw new Error("Caught error");
      };

      const result = await executeMiddleware([errorHandler, errorThrower], ctx);

      expect(result).toBeNull();
      expect(caughtError?.message).toBe("Caught error");
    });
  });

  describe("async middleware", () => {
    it("should handle async operations", async () => {
      const ctx = createContext();
      const order: string[] = [];

      const asyncMiddleware: MiddlewareFn = async (_ctx, next) => {
        order.push("async-start");
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push("async-end");
        await next();
      };

      const syncMiddleware: MiddlewareFn = async (_ctx, next) => {
        order.push("sync");
        await next();
      };

      await executeMiddleware([asyncMiddleware, syncMiddleware], ctx);

      expect(order).toEqual(["async-start", "async-end", "sync"]);
    });

    it("should handle Promise-returning middleware", async () => {
      const ctx = createContext();
      let resolved = false;

      const promiseMiddleware: MiddlewareFn = (_ctx, next) => {
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            resolved = true;
            resolve();
          }, 10);
        }).then(() => next());
      };

      await executeMiddleware([promiseMiddleware], ctx);

      expect(resolved).toBe(true);
    });
  });

  describe("context modification", () => {
    it("should allow middleware to modify context variables", async () => {
      const variables: Record<string, any> = {};
      const ctx = {
        ...createContext(),
        var: variables,
        set: (key: string, value: any) => {
          variables[key] = value;
        },
        get: (key: string) => variables[key],
      };

      const authMiddleware: MiddlewareFn = async (c, next) => {
        c.set("user", { id: "123", role: "admin" });
        await next();
      };

      const permissionMiddleware: MiddlewareFn = async (c, next) => {
        const user = c.get("user");
        c.set("permissions", user?.role === "admin" ? ["read", "write"] : ["read"]);
        await next();
      };

      await executeMiddleware([authMiddleware, permissionMiddleware], ctx);

      expect(ctx.get("user")).toEqual({ id: "123", role: "admin" });
      expect(ctx.get("permissions")).toEqual(["read", "write"]);
    });
  });

  describe("redirect responses", () => {
    it("should handle redirect response from middleware", async () => {
      const ctx = createContext();

      const redirectMiddleware: MiddlewareFn = async () => {
        return Response.redirect("http://localhost/login", 302);
      };

      const result = await executeMiddleware([redirectMiddleware], ctx);

      expect(result).toBeInstanceOf(Response);
      expect(result?.status).toBe(302);
    });

    it("should handle custom redirect responses", async () => {
      const ctx = createContext();

      const customRedirect: MiddlewareFn = async () => {
        return new Response(null, {
          status: 307,
          headers: { Location: "/new-location" },
        });
      };

      const result = await executeMiddleware([customRedirect], ctx);

      expect(result?.status).toBe(307);
      expect(result?.headers.get("Location")).toBe("/new-location");
    });
  });

  describe("named middleware", () => {
    it("should work with named functions", async () => {
      const ctx = createContext();
      const executed: string[] = [];

      async function authMiddleware(_ctx: any, next: () => Promise<void>) {
        executed.push("auth");
        await next();
      }

      async function loggingMiddleware(_ctx: any, next: () => Promise<void>) {
        executed.push("logging");
        await next();
      }

      await executeMiddleware([authMiddleware, loggingMiddleware], ctx);

      expect(executed).toEqual(["auth", "logging"]);
    });
  });
});
