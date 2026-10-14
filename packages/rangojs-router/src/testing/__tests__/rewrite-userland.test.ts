/**
 * `throw rewrite()` through the public testing primitives a consumer uses:
 * runMiddleware reports the rewrite, dispatch re-dispatches as production
 * does (response routes; dispatch renders no RSC route).
 */
import { describe, expect, it, vi } from "vitest";

function pluginRscMock() {
  return {
    createFromReadableStream: vi.fn(),
    renderToReadableStream: vi.fn(),
    loadServerAction: vi.fn(),
    decodeReply: vi.fn(),
    decodeAction: vi.fn(),
    decodeFormState: vi.fn(),
    createTemporaryReferenceSet: vi.fn(),
  };
}
vi.mock("@vitejs/plugin-rsc/rsc/server", pluginRscMock);
vi.mock("@vitejs/plugin-rsc/rsc/client", pluginRscMock);

import { dispatch, runMiddleware } from "../index.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import {
  cookies,
  createRouter,
  createVar,
  getRequestContext,
  rewrite,
  urls,
  type MiddlewareFn,
  type OnErrorContext,
} from "../../index.rsc.js";

const Lock = createVar<{ until: string }>();

const lockMiddleware: MiddlewareFn = async (ctx, next) => {
  if (ctx.request.headers.get("x-lock") !== "on") return next();
  if (ctx.pathname === "/api/maintenance") return next();
  if (ctx.request.method !== "GET") {
    return new Response("Maintenance", {
      status: 503,
      headers: { "Retry-After": "600" },
    });
  }
  ctx.set(Lock, { until: "12:00" });
  cookies().set("lock-seen", "1");
  throw rewrite("api.maintenance");
};

describe("runMiddleware reports a thrown rewrite", () => {
  it("resolves a route-name target through routeMap", async () => {
    const result = await runMiddleware(lockMiddleware, {
      request: new Request("http://localhost/api/orders", {
        headers: { "x-lock": "on" },
      }),
      routeMap: { "api.maintenance": "/api/maintenance" },
    });
    expect(result.rewrite).toEqual({
      pathname: "/api/maintenance",
      search: "",
      routeName: "api.maintenance",
    });
    expect(result.nextCalled).toBe(0);
    expect(result.ctx.get(Lock)).toEqual({ until: "12:00" });
    expect(result.cookies["lock-seen"]).toBe("1");
  });

  it("resolves a path target with the basename and search", async () => {
    const mw: MiddlewareFn = () => {
      throw rewrite("/maintenance?from=shop");
    };
    const result = await runMiddleware(mw, {
      request: "/app/shop",
      basename: "/app",
    });
    expect(result.rewrite).toEqual({
      pathname: "/app/maintenance",
      search: "?from=shop",
    });
  });

  it("reports a lock's disallowMutations() choice", async () => {
    const lock: MiddlewareFn = () => {
      throw rewrite("/maintenance").shell("target").disallowMutations();
    };
    const result = await runMiddleware(lock, {
      request: new Request("http://localhost/cart", { method: "POST" }),
    });
    expect(result.rewrite).toEqual({
      pathname: "/maintenance",
      search: "",
      mutationsDisallowed: true,
    });
  });

  it("leaves rewrite undefined when the chain does not rewrite", async () => {
    const result = await runMiddleware(lockMiddleware, {
      request: "/api/orders",
    });
    expect(result.rewrite).toBeUndefined();
    expect(result.nextCalled).toBe(1);
  });

  it("returns the mutation's Response instead of rewriting", async () => {
    const result = await runMiddleware(lockMiddleware, {
      request: new Request("http://localhost/api/orders", {
        method: "POST",
        headers: { "x-lock": "on" },
      }),
    });
    expect(result.rewrite).toBeUndefined();
    expect(result.response.status).toBe(503);
    expect(result.headers["retry-after"]).toBe("600");
  });
});

describe("dispatch re-dispatches a rewritten request", () => {
  const errors: OnErrorContext[] = [];
  const router = createRouter({
    onError: (context) => {
      errors.push(context);
    },
  })
    .use(lockMiddleware)
    .use("/api/admin/*", async (ctx, next) => {
      if (ctx.request.headers.get("x-admin") !== "yes") {
        return new Response("Unauthorized", { status: 401 });
      }
      return next();
    })
    .use("/api/loop/*", async (ctx) => {
      throw rewrite(
        ctx.pathname === "/api/loop/a" ? "/api/loop/b" : "/api/loop/a",
      );
    })
    .routes(
      urls(({ path, middleware }) => [
        path.json("/api/orders", () => ({ orders: [] }), {
          name: "api.orders",
        }),
        path.json(
          "/api/maintenance",
          (ctx) => ({
            maintenance: true,
            until: ctx.get(Lock)?.until ?? null,
            at: ctx.pathname,
            from: ctx.rewrittenFrom?.pathname ?? null,
          }),
          { name: "api.maintenance" },
          () => [
            middleware(async (_ctx, next) => {
              getRequestContext().setStatus(503);
              await next();
            }),
          ],
        ),
        path.json("/api/admin/stats", () => ({ stats: 1 }), {
          name: "api.admin",
        }),
        path.json(
          "/api/report",
          () => ({ never: true }),
          {},
          () => [
            middleware(() => {
              throw rewrite("api.admin");
            }),
          ],
        ),
        path.json("/api/loop/a", () => ({ a: true })),
        path.json("/api/loop/b", () => ({ b: true })),
      ]),
    );

  it("renders the target with the same context at the visitor's URL", async () => {
    const res = await dispatch(router, {
      request: new Request("http://localhost/api/orders", {
        headers: { "x-lock": "on" },
      }),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("x-rango-rewrite")).toBe("/api/maintenance");
    expect(res.headers.getSetCookie().join()).toContain("lock-seen=1");
    expect(await res.json()).toEqual({
      maintenance: true,
      until: "12:00",
      at: "/api/maintenance",
      from: "/api/orders",
    });
  });

  it("serves the visitor's own route when nothing rewrites", async () => {
    const res = await dispatch(router, { request: "/api/orders" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-rango-rewrite")).toBeNull();
    expect(await res.json()).toEqual({ orders: [] });
  });

  it("runs the target's pattern-scoped global middleware", async () => {
    const denied = await dispatch(router, { request: "/api/report" });
    expect(denied.status).toBe(401);

    const allowed = await dispatch(router, {
      request: new Request("http://localhost/api/report", {
        headers: { "x-admin": "yes" },
      }),
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("x-rango-rewrite")).toBe("/api/admin/stats");
    expect(await allowed.json()).toEqual({ stats: 1 });
  });

  it("answers a loop with 508 and reports it through onError", async () => {
    errors.length = 0;
    const res = await dispatch(router, { request: "/api/loop/a" });
    expect(res.status).toBe(508);
    expect(errors.map((e) => [e.phase, e.error.name])).toEqual([
      ["routing", "RewriteLoopError"],
    ]);
  });

  it("moves a mutation to the target, whose handler serves it with its body; disallowMutations() refuses it", async () => {
    errors.length = 0;
    const mover = createRouter({
      onError: (context) => {
        errors.push(context);
      },
    })
      .use((ctx, next) => {
        if (ctx.pathname !== "/api/orders") return next();
        const target = rewrite("/api/v2/orders");
        throw ctx.request.headers.get("x-lock") === "strict"
          ? target.disallowMutations()
          : target;
      })
      .routes(
        urls(({ path }) => [
          path.json("/api/v2/orders", async (ctx) => ({
            method: ctx.request.method,
            body: await ctx.request.text(),
          })),
          path.json("/api/orders", () => ({ version: 1 })),
        ]),
      );
    const post = (headers: Record<string, string> = {}) =>
      dispatch(mover, {
        request: new Request("http://localhost/api/orders", {
          method: "POST",
          headers,
          body: "order",
        }),
      });

    const moved = await post();
    expect(moved.status).toBe(200);
    expect(moved.headers.get("x-rango-rewrite")).toBe("/api/v2/orders");
    expect(await moved.json()).toEqual({ method: "POST", body: "order" });
    expect(errors).toEqual([]);

    await expect(post({ "x-lock": "strict" })).rejects.toThrow(
      "refused a mutation: .disallowMutations() was set",
    );
    expect(errors.map((e) => e.phase)).toEqual(["routing"]);
  });

  it("a cached response route that rewrites keeps the pre-handler onResponse callbacks", async () => {
    const callbackRouter = createRouter({
      cache: { store: new MemorySegmentCacheStore() },
    })
      .use(async (ctx, next) => {
        // Registered once, on the visitor's pass.
        if (!ctx.rewrittenFrom) {
          getRequestContext().onResponse((response) => {
            response.headers.set("x-pre-handler", "ran");
            return response;
          });
        }
        return next();
      })
      .routes(
        urls(({ path, middleware, cache }) => [
          cache({ ttl: 60 }, () => [
            path.json(
              "/api/cached",
              () => ({ cached: true }),
              {},
              () => [
                middleware(() => {
                  throw rewrite("/api/fallback");
                }),
              ],
            ),
          ]),
          path.json("/api/fallback", () => ({ fallback: true })),
        ]),
      );
    const res = await dispatch(callbackRouter, { request: "/api/cached" });
    expect(await res.json()).toEqual({ fallback: true });
    expect(res.headers.get("x-pre-handler")).toBe("ran");
  });

  it("a cached response route a rewritten request read the visitor's URL in is not stored", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const itemRouter = createRouter({ cache: { store: cacheStore } })
      .use("/api/promo", () => {
        throw rewrite("/api/item");
      })
      .routes(
        urls(({ path, cache }) => [
          cache({ ttl: 60 }, () => [
            path.json("/api/item", (ctx) => ({
              from: ctx.rewrittenFrom?.pathname ?? "direct",
            })),
          ]),
          path.json("/api/promo", () => ({ never: true })),
        ]),
      );
    const rewritten = await dispatch(itemRouter, { request: "/api/promo" });
    expect(await rewritten.json()).toEqual({ from: "/api/promo" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const direct = await dispatch(itemRouter, { request: "/api/item" });
    expect(await direct.json()).toEqual({ from: "direct" });
  });

  it("a stale cached response route that now rewrites reports nothing", async () => {
    let locked = false;
    const staleErrors: OnErrorContext[] = [];
    const staleRouter = createRouter({
      cache: { store: new MemorySegmentCacheStore() },
      onError: (context) => {
        staleErrors.push(context);
      },
    }).routes(
      urls(({ path, cache, middleware }) => [
        cache({ ttl: 0, swr: 300 }, () => [
          path.json(
            "/api/feed",
            () => ({ feed: true }),
            {},
            () => [
              middleware(async (_ctx, next) => {
                if (locked) throw rewrite("/api/lock");
                return next();
              }),
            ],
          ),
        ]),
        path.json("/api/lock", () => ({ lock: true })),
      ]),
    );
    await dispatch(staleRouter, { request: "/api/feed" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    locked = true;
    const stale = await dispatch(staleRouter, { request: "/api/feed" });
    expect(await stale.json()).toEqual({ feed: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(staleErrors).toEqual([]);
  });

  it("reloads a partial request at the visitor's URL", async () => {
    const res = await dispatch(router, {
      request: new Request("http://localhost/api/orders?_rsc_partial=true", {
        headers: { "x-lock": "on" },
      }),
    });
    expect(res.headers.get("x-rsc-reload")).toBe("http://localhost/api/orders");
  });
});
