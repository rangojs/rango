import { describe, it, expect } from "vitest";
import { runMiddleware } from "../run-middleware.js";
import { cookies } from "../../server/cookie-store.js";
import { redirect } from "../../route-definition/redirect.js";
import type { MiddlewareFn } from "../../router/middleware.js";

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

  it("normalizes a non-canonical basename exactly like createRouter", async () => {
    // createRouter normalizes the basename (leading slash forced, trailing
    // stripped, bare "/" -> undefined). The helper must match, so a consumer
    // passing the same un-normalized value their router accepts observes the
    // same Location. Pre-fix this produced "app/login" / "/app//login" / "//login".
    const mw: MiddlewareFn = async () => redirect("/login");

    const noLead = await runMiddleware(mw, "/dashboard", { basename: "app" });
    expect(noLead.response.headers.get("Location")).toBe("/app/login");

    const trailing = await runMiddleware(mw, "/dashboard", {
      basename: "/app/",
    });
    expect(trailing.response.headers.get("Location")).toBe("/app/login");

    const bare = await runMiddleware(mw, "/dashboard", { basename: "/" });
    expect(bare.response.headers.get("Location")).toBe("/login");
  });

  it("returned ctx.reverse is map-only (matches the chain), NOT auto-fill", async () => {
    // Middleware-phase reverse is map-only in production; the RETURNED ctx must
    // reflect that too. Pre-fix createTestRequestContext installed the
    // loader-phase auto-fill reverse on the returned ctx, so reading
    // result.ctx.reverse("post") wrongly produced "/blog/hello".
    const { ctx } = await runMiddleware(
      async (_c, next) => next(),
      "/blog/hello",
      {
        routeMap: { post: "/blog/:slug" },
        routeName: "post",
        params: { slug: "hello" },
      },
    );
    const rev = (ctx as unknown as { reverse: (n: string) => string }).reverse;
    expect(rev("post")).toBe("/blog/:slug");
  });

  it("ctx.reverse does NOT auto-fill the current params (production parity)", async () => {
    // Production app/response middleware get createReverseFunction(routeMap)
    // alone — no route name or current params. Reversing a :slug route with no
    // explicit params must leave it unsubstituted, NOT fill from the request.
    let reversed: string | undefined;
    const mw: MiddlewareFn = async (ctx, next) => {
      reversed = (ctx as { reverse: (n: string) => string }).reverse("post");
      return next();
    };
    await runMiddleware(mw, "/blog/hello", {
      routeMap: { post: "/blog/:slug" },
      routeName: "post",
      params: { slug: "hello" },
    });
    expect(reversed).toBe("/blog/:slug");
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

  it("surfaces a cookie set inside middleware on result.cookies and the response", async () => {
    const mw: MiddlewareFn = async (_ctx, next) => {
      cookies().set("session", "abc123", { path: "/" });
      return next();
    };

    const { response, cookies: cookieView } = await runMiddleware(mw, "/");

    // Public effective cookie view — no cast through the @internal ctx.cookies().
    expect(cookieView.session).toBe("abc123");
    // Observable on the merged downstream response Set-Cookie header.
    const setCookie = response.headers.getSetCookie();
    expect(setCookie.some((c) => c.startsWith("session=abc123"))).toBe(true);
  });

  it("surfaces a header set inside middleware on result.headers", async () => {
    const mw: MiddlewareFn = async (ctx, next) => {
      ctx.header("X-Frame-Options", "DENY");
      return next();
    };

    const { headers, response } = await runMiddleware(mw, "/");

    // Public header view (names lowercased), excluding set-cookie.
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
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
