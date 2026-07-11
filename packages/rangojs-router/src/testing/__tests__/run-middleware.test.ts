import { describe, it, expect } from "vitest";
import { runMiddleware } from "../run-middleware.js";
import {
  cookies,
  invalidateClientCache,
  keepClientCache,
} from "../../server/cookie-store.js";
import { KEEP_CACHE_HEADER } from "../../browser/cookie-name.js";
import { redirect } from "../../route-definition/redirect.js";
import type { MiddlewareFn } from "../../router/middleware.js";

describe("runMiddleware", () => {
  it("prefixes a redirect() Location with the seeded basename", async () => {
    // redirect() reads _basename from the active request context; seeding
    // `basename` lets a middleware redirect be tested as it behaves in a real
    // sub-path-mounted app (instead of always producing no prefix).
    const mw: MiddlewareFn = async () => redirect("/login");
    const { response } = await runMiddleware(mw, {
      request: "/dashboard",
      basename: "/app",
    });
    expect(response.headers.get("Location")).toBe("/app/login");
  });

  it("does NOT prefix the redirect when no basename is seeded", async () => {
    const mw: MiddlewareFn = async () => redirect("/login");
    const { response } = await runMiddleware(mw, { request: "/dashboard" });
    expect(response.headers.get("Location")).toBe("/login");
  });

  it("surfaces location state a middleware set via redirect({ state })", async () => {
    // Parity with runInRequestContext/renderHandler: a middleware that sets a
    // flash via redirect({ state }) has it observable on result.locationState.
    // NOTE: the helper snapshots location state PRE-SSR-loss (the contract). The
    // redirect() dev warning about full-page SSR is expected here; do not "fix"
    // the assertion to {} — the snapshot intentionally reflects what an SPA nav
    // would deliver, matching runInRequestContext.
    const mw: MiddlewareFn = async () =>
      redirect("/login", {
        state: [{ __rsc_ls_key: "flash", __rsc_ls_value: { text: "Sign in" } }],
      });
    const { locationState, response } = await runMiddleware(mw, {
      request: "/dashboard",
    });
    expect(response.headers.get("Location")).toBe("/login");
    expect(locationState).toEqual({ flash: { text: "Sign in" } });
  });

  it("normalizes a non-canonical basename exactly like createRouter", async () => {
    // createRouter normalizes the basename (leading slash forced, trailing
    // stripped, bare "/" -> undefined). The helper must match, so a consumer
    // passing the same un-normalized value their router accepts observes the
    // same Location. Pre-fix this produced "app/login" / "/app//login" / "//login".
    const mw: MiddlewareFn = async () => redirect("/login");

    const noLead = await runMiddleware(mw, {
      request: "/dashboard",
      basename: "app",
    });
    expect(noLead.response.headers.get("Location")).toBe("/app/login");

    const trailing = await runMiddleware(mw, {
      request: "/dashboard",
      basename: "/app/",
    });
    expect(trailing.response.headers.get("Location")).toBe("/app/login");

    const bare = await runMiddleware(mw, {
      request: "/dashboard",
      basename: "/",
    });
    expect(bare.response.headers.get("Location")).toBe("/login");
  });

  it("returned ctx.reverse is map-only (matches the chain), NOT auto-fill", async () => {
    // Middleware-phase reverse is map-only in production; the RETURNED ctx must
    // reflect that too. Pre-fix createTestRequestContext installed the
    // loader-phase auto-fill reverse on the returned ctx, so reading
    // result.ctx.reverse("post") wrongly produced "/blog/hello".
    const { ctx } = await runMiddleware(async (_c, next) => next(), {
      request: "/blog/hello",
      routeMap: { post: "/blog/:slug" },
      routeName: "post",
      params: { slug: "hello" },
    });
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
    await runMiddleware(mw, {
      request: "/blog/hello",
      routeMap: { post: "/blog/:slug" },
      routeName: "post",
      params: { slug: "hello" },
    });
    expect(reversed).toBe("/blog/:slug");
  });

  it("passes through (next called once) and returns the downstream 200", async () => {
    const mw: MiddlewareFn = async (_ctx, next) => next();
    const { response, nextCalled } = await runMiddleware(mw, {
      request: "/dashboard",
    });

    expect(nextCalled).toBe(1);
    expect(response.status).toBe(200);
  });

  it("uses opts.next as the terminal handler", async () => {
    const mw: MiddlewareFn = async (_ctx, next) => next();
    const { response, nextCalled } = await runMiddleware(mw, {
      request: "/x",
      next: async () => new Response("downstream", { status: 201 }),
    });

    expect(nextCalled).toBe(1);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("downstream");
  });

  it("short-circuits via returned Response (next NOT called)", async () => {
    const mw: MiddlewareFn = async () => new Response(null, { status: 401 });
    const { response, nextCalled } = await runMiddleware(mw, {
      request: "/secret",
    });

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
    const { response, nextCalled } = await runMiddleware(mw, {
      request: "/secret",
    });

    expect(nextCalled).toBe(0);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login");
  });

  it("reads variables seeded via vars", async () => {
    const mw: MiddlewareFn = async (ctx, next) => {
      if (!ctx.get("user")) return new Response(null, { status: 401 });
      return next();
    };

    const allowed = await runMiddleware(mw, {
      request: "/dashboard",
      vars: [["user", { id: 1 }]],
    });
    expect(allowed.nextCalled).toBe(1);
    expect(allowed.response.status).toBe(200);

    const denied = await runMiddleware(mw, { request: "/dashboard" });
    expect(denied.nextCalled).toBe(0);
    expect(denied.response.status).toBe(401);
  });

  it("surfaces a cookie set inside middleware on result.cookies and the response", async () => {
    const mw: MiddlewareFn = async (_ctx, next) => {
      cookies().set("session", "abc123", { path: "/" });
      return next();
    };

    const { response, cookies: cookieView } = await runMiddleware(mw, {
      request: "/",
    });

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

    const { headers, response } = await runMiddleware(mw, { request: "/" });

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

    const { nextCalled } = await runMiddleware([a, b], { request: "/" });
    expect(order).toEqual(["a", "b"]);
    expect(nextCalled).toBe(1);
  });

  it("resolves ctx.reverse from opts.routeMap inside middleware", async () => {
    let reversed = "";
    const mw: MiddlewareFn = async (ctx, next) => {
      reversed = ctx.reverse("post", { slug: "hi" });
      return next();
    };

    await runMiddleware(mw, {
      request: "/",
      routeMap: { post: "/blog/:slug" },
    });
    expect(reversed).toBe("/blog/hi");
  });

  describe("invalidateClientCache / keepClientCache + stateCookieName", () => {
    const stateCookies = (res: Response) =>
      res.headers.getSetCookie().filter((c) => c.startsWith("rango-state_"));

    it("a middleware calling invalidateClientCache() rotates the state cookie and exposes stateCookieName", async () => {
      const mw: MiddlewareFn = async (_ctx, next) => {
        invalidateClientCache();
        return next();
      };
      const { response, stateCookieName, nextCalled } = await runMiddleware(
        mw,
        {
          request: "/dashboard",
        },
      );
      expect(nextCalled).toBe(1);
      // result.stateCookieName surfaces the resolved name (parity with the other primitives).
      expect(stateCookieName).toBe("rango-state_router_0");
      const cookies = stateCookies(response);
      expect(cookies).toHaveLength(1);
      expect(cookies[0].startsWith(stateCookieName + "=")).toBe(true);
    });

    it("a middleware calling keepClientCache() sets the directive header and no cookie", async () => {
      const mw: MiddlewareFn = async (_ctx, next) => {
        keepClientCache();
        return next();
      };
      const { headers, response } = await runMiddleware(mw, {
        request: "/dashboard",
      });
      expect(headers[KEEP_CACHE_HEADER]).toBe("1");
      expect(stateCookies(response)).toHaveLength(0);
    });

    it("the stateCookie seed customizes the rotated name and matches result.stateCookieName", async () => {
      const mw: MiddlewareFn = async (_ctx, next) => {
        invalidateClientCache();
        return next();
      };
      const { response, stateCookieName } = await runMiddleware(mw, {
        request: "/dashboard",
        stateCookie: { prefix: "myapp", routerId: "shop", version: "v9" },
      });
      expect(stateCookieName).toBe("myapp_shop");
      const [cookie] = response.headers
        .getSetCookie()
        .filter((c) => c.startsWith("myapp_shop="));
      expect(cookie).toMatch(/^myapp_shop=v9:\d+;/);
    });
  });

  describe("build + ctx.dynamic() (PPR shell opt-out)", () => {
    // The build-time PPR shell-capture producer replays middleware with a
    // synthetic build context, so a consumer whose middleware branches on
    // ctx.build (e.g. `if (ctx.build) ctx.dynamic()`) must be unit-testable
    // through the public primitive. build defaults false; seeding it true makes
    // that branch reachable and result.dynamic surfaces the opt-out.
    const buildGatedOptOut: MiddlewareFn = async (ctx, next) => {
      if (ctx.build) ctx.dynamic();
      return next();
    };

    it("build:true makes ctx.build true and the ctx.dynamic() branch reachable", async () => {
      const { ctx, dynamic, nextCalled } = await runMiddleware(
        buildGatedOptOut,
        { request: "/pp/alpha", build: true },
      );
      expect(ctx.build).toBe(true);
      expect(dynamic).toBe(true);
      // dynamic() forces the dynamic axis but does not short-circuit the chain.
      expect(nextCalled).toBe(1);
    });

    it("defaults to build:false, so the same middleware does NOT opt out", async () => {
      const { ctx, dynamic } = await runMiddleware(buildGatedOptOut, {
        request: "/pp/alpha",
      });
      expect(ctx.build).toBe(false);
      expect(dynamic).toBe(false);
    });

    it("surfaces an unconditional ctx.dynamic() on result.dynamic at runtime", async () => {
      const mw: MiddlewareFn = async (ctx, next) => {
        ctx.dynamic();
        return next();
      };
      const { dynamic } = await runMiddleware(mw, { request: "/pp/alpha" });
      expect(dynamic).toBe(true);
    });

    it("ctx.waitUntil() is inert under build:true (matches the build producer)", async () => {
      let ran = false;
      const mw: MiddlewareFn = async (ctx, next) => {
        ctx.waitUntil(async () => {
          ran = true;
        });
        return next();
      };
      await runMiddleware(mw, { request: "/pp/alpha", build: true });
      await new Promise((r) => setTimeout(r, 0));
      expect(ran).toBe(false);
    });
  });
});
