import { describe, it, expect } from "vitest";
import { runMiddleware } from "../run-middleware.js";
import { cookies } from "../../server/cookie-store.js";
import { redirect } from "../../route-definition/redirect.js";
import type { MiddlewareFn } from "../../router/middleware.js";
import type { RequestContext } from "../../server/request-context.js";

describe("runMiddleware", () => {
  it("prefixes a redirect() Location with the seeded basename", async () => {
    // redirect() reads _basename from the active request context; seeding
    // `basename` lets a middleware redirect be tested as it behaves in a real
    // sub-path-mounted app (instead of always producing no prefix).
    const mw: MiddlewareFn = async () => redirect("/login");
    const { response } = await runMiddleware(mw, "/dashboard", {
      basename: "/app",
    });
    expect(response.headers.get("Location")).toBe("/app/login");
  });

  it("does NOT prefix the redirect when no basename is seeded", async () => {
    const mw: MiddlewareFn = async () => redirect("/login");
    const { response } = await runMiddleware(mw, "/dashboard");
    expect(response.headers.get("Location")).toBe("/login");
  });

  it("passes through (next called once) and returns the downstream 200", async () => {
    const mw: MiddlewareFn = async (_ctx, next) => next();
    const { response, nextCalled } = await runMiddleware(mw, "/dashboard");

    expect(nextCalled).toBe(1);
    expect(response.status).toBe(200);
  });

  it("uses opts.next as the terminal handler", async () => {
    const mw: MiddlewareFn = async (_ctx, next) => next();
    const { response, nextCalled } = await runMiddleware(mw, "/x", {
      next: async () => new Response("downstream", { status: 201 }),
    });

    expect(nextCalled).toBe(1);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("downstream");
  });

  it("short-circuits via returned Response (next NOT called)", async () => {
    const mw: MiddlewareFn = async () => new Response(null, { status: 401 });
    const { response, nextCalled } = await runMiddleware(mw, "/secret");

    expect(nextCalled).toBe(0);
    expect(response.status).toBe(401);
  });

  it("short-circuits via thrown Response (next NOT called)", async () => {
    const mw: MiddlewareFn = async () => {
      throw new Response(null, {
        status: 302,
        headers: { Location: "/login" },
      });
    };
    const { response, nextCalled } = await runMiddleware(mw, "/secret");

    expect(nextCalled).toBe(0);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login");
  });

  it("reads variables seeded via vars", async () => {
    const mw: MiddlewareFn = async (ctx, next) => {
      if (!ctx.get("user")) return new Response(null, { status: 401 });
      return next();
    };

    const allowed = await runMiddleware(mw, "/dashboard", {
      vars: [["user", { id: 1 }]],
    });
    expect(allowed.nextCalled).toBe(1);
    expect(allowed.response.status).toBe(200);

    const denied = await runMiddleware(mw, "/dashboard");
    expect(denied.nextCalled).toBe(0);
    expect(denied.response.status).toBe(401);
  });

  it("makes a cookie set inside middleware observable on ctx and the response", async () => {
    const mw: MiddlewareFn = async (_ctx, next) => {
      cookies().set("session", "abc123", { path: "/" });
      return next();
    };

    const { response, ctx } = await runMiddleware(mw, "/");

    // Observable on the RequestContext effective cookie view.
    expect((ctx as RequestContext).cookies().session).toBe("abc123");
    // Observable on the merged downstream response Set-Cookie header.
    const setCookie = response.headers.getSetCookie();
    expect(setCookie.some((c) => c.startsWith("session=abc123"))).toBe(true);
  });

  it("runs an array of middleware in order", async () => {
    const order: string[] = [];
    const a: MiddlewareFn = async (_ctx, next) => {
      order.push("a");
      return next();
    };
    const b: MiddlewareFn = async (_ctx, next) => {
      order.push("b");
      return next();
    };

    const { nextCalled } = await runMiddleware([a, b], "/");
    expect(order).toEqual(["a", "b"]);
    expect(nextCalled).toBe(1);
  });

  it("resolves ctx.reverse from opts.routeMap inside middleware", async () => {
    let reversed = "";
    const mw: MiddlewareFn = async (ctx, next) => {
      reversed = ctx.reverse("post", { slug: "hi" });
      return next();
    };

    await runMiddleware(mw, "/", { routeMap: { post: "/blog/:slug" } });
    expect(reversed).toBe("/blog/hi");
  });
});
