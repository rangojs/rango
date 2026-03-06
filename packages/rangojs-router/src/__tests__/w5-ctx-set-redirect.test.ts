import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executeMiddleware, _resetW5Warnings } from "../router/middleware.js";
import type { MiddlewareEntry } from "../router/middleware-types.js";

function makeEntry(handler: MiddlewareEntry["handler"]): {
  entry: MiddlewareEntry;
  params: Record<string, string>;
} {
  return {
    entry: {
      handler,
      pattern: "*",
      regex: null,
      paramNames: [],
      mountPrefix: null,
    },
    params: {},
  };
}

const dummyRequest = new Request("https://example.com/test");
const dummyFinalHandler = async () => new Response("ok");

describe("W5: ctx.set() then redirect warning", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetW5Warnings();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns when middleware calls ctx.set() then returns a redirect", async () => {
    const mw = makeEntry(async (ctx) => {
      ctx.set("authUser", "alice");
      return new Response(null, {
        status: 302,
        headers: { Location: "/login" },
      });
    });

    await executeMiddleware([mw], dummyRequest, {}, {}, dummyFinalHandler);

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toContain("ctx.set()");
    expect(warnSpy.mock.calls[0]![0]).toContain("redirect");
  });

  it("does not warn when middleware returns a redirect without ctx.set()", async () => {
    const mw = makeEntry(async () => {
      return new Response(null, {
        status: 302,
        headers: { Location: "/login" },
      });
    });

    await executeMiddleware([mw], dummyRequest, {}, {}, dummyFinalHandler);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not warn when middleware calls ctx.set() but returns a non-redirect Response", async () => {
    const mw = makeEntry(async (ctx) => {
      ctx.set("user", "bob");
      return new Response("forbidden", { status: 403 });
    });

    await executeMiddleware([mw], dummyRequest, {}, {}, dummyFinalHandler);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not warn when middleware calls ctx.set() and calls next() (no redirect)", async () => {
    const mw = makeEntry(async (ctx, next) => {
      ctx.set("theme", "dark");
      return next();
    });

    await executeMiddleware([mw], dummyRequest, {}, {}, dummyFinalHandler);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not warn for ctx.header() + redirect (headers survive redirects)", async () => {
    const mw = makeEntry(async (ctx) => {
      ctx.header("X-Custom", "value");
      return new Response(null, {
        status: 301,
        headers: { Location: "/new" },
      });
    });

    await executeMiddleware([mw], dummyRequest, {}, {}, dummyFinalHandler);

    // ctx.header() does not mutate variables, so no warning
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("deduplicates warnings by function reference", async () => {
    async function authMiddleware(ctx: any) {
      ctx.set("authUser", "alice");
      return new Response(null, {
        status: 302,
        headers: { Location: "/login" },
      });
    }

    const mw = makeEntry(authMiddleware);

    await executeMiddleware([mw], dummyRequest, {}, {}, dummyFinalHandler);
    await executeMiddleware([mw], dummyRequest, {}, {}, dummyFinalHandler);

    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("warns separately for different anonymous middleware", async () => {
    const mwA = makeEntry(async (ctx) => {
      ctx.set("a", "1");
      return new Response(null, { status: 302, headers: { Location: "/x" } });
    });
    const mwB = makeEntry(async (ctx) => {
      ctx.set("b", "2");
      return new Response(null, { status: 302, headers: { Location: "/y" } });
    });

    await executeMiddleware([mwA], dummyRequest, {}, {}, dummyFinalHandler);
    await executeMiddleware([mwB], dummyRequest, {}, {}, dummyFinalHandler);

    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("warns when ctx.set() overwrites an existing key", async () => {
    const mw = makeEntry(async (ctx) => {
      ctx.set("user", "updated");
      return new Response(null, {
        status: 302,
        headers: { Location: "/login" },
      });
    });

    // Parent middleware already set "user" before this middleware runs
    const variables: Record<string, any> = { user: "original" };
    await executeMiddleware(
      [mw],
      dummyRequest,
      {},
      variables,
      dummyFinalHandler,
    );

    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("warns for 301 permanent redirects too", async () => {
    const mw = makeEntry(async (ctx) => {
      ctx.set("data", "value");
      return new Response(null, {
        status: 301,
        headers: { Location: "/moved" },
      });
    });

    await executeMiddleware([mw], dummyRequest, {}, {}, dummyFinalHandler);

    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("detects ctx.set() with ContextVar tokens (symbol keys)", async () => {
    const { createVar } = await import("../context-var.js");
    const Token = createVar<string>();

    const mw = makeEntry(async (ctx) => {
      ctx.set(Token, "value");
      return new Response(null, {
        status: 302,
        headers: { Location: "/target" },
      });
    });

    await executeMiddleware([mw], dummyRequest, {}, {}, dummyFinalHandler);

    expect(warnSpy).toHaveBeenCalledOnce();
  });
});
