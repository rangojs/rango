import { describe, it, expect } from "vitest";
import {
  runInRequestContext,
  runWithRequestContext,
  createTestRequestContext,
} from "../index.js";
import { getRequestContext } from "../../server/request-context.js";
import {
  cookies,
  invalidateClientCache,
  keepClientCache,
} from "../../server/cookie-store.js";
import { KEEP_CACHE_HEADER } from "../../browser/cookie-name.js";
import { redirect } from "../../route-definition/redirect.js";
import { createVar } from "../../context-var.js";
import { registerSearchSchema } from "../../route-map-builder.js";
import type { LoaderDefinition } from "../../types.js";

// runInRequestContext is the reachable entry for the advanced action-auth path:
// a server action has no loader context (so runLoader is the wrong shape) yet
// still needs a real request context to read the request cookie and resolve
// getRequestContext(). It returns { result, thrown, response, cookies,
// locationState } so the action's OUTPUT (Set-Cookie, headers, flash) is
// assertable at the unit layer — whether fn returns OR throws (e.g. a success
// `throw redirect(...)`) — without casting through @internal ctx.res/ctx.cookies().

describe("runInRequestContext", () => {
  it("enters a context so getRequestContext() resolves inside fn", async () => {
    const { result } = await runInRequestContext(
      () => getRequestContext().method,
    );
    expect(result).toBe("GET");
  });

  it("authenticates off the request Cookie (the action-auth case)", async () => {
    // Mirrors authorizeTenantAction: read the session cookie, then decide.
    async function authorize(): Promise<{ session: string } | null> {
      const sid = getRequestContext().cookies()["sid"];
      if (!sid) return null;
      return { session: sid };
    }

    const { result: authed } = await runInRequestContext(() => authorize(), {
      request: new Request("https://app.test/admin", {
        headers: { Cookie: "sid=abc123" },
      }),
    });
    expect(authed).toEqual({ session: "abc123" });

    const { result: anon } = await runInRequestContext(() => authorize(), {
      request: new Request("https://app.test/admin"),
    });
    expect(anon).toBeNull();
  });

  it("surfaces env and seeded vars to fn", async () => {
    const userVar = createVar<{ id: number }>();
    const { result } = await runInRequestContext(
      () => {
        const ctx = getRequestContext<{ region: string }>();
        return {
          region: ctx.env.region,
          // tuple form seeds by the createVar() handle, read back by the handle
          user: ctx.get(userVar),
        };
      },
      { env: { region: "eu" }, vars: [[userVar, { id: 7 }]] },
    );
    expect(result).toEqual({ region: "eu", user: { id: 7 } });
  });

  it("keeps the context active across awaits in an async fn", async () => {
    const { result } = await runInRequestContext(
      async () => {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
        // getRequestContext() must still resolve after awaits (AsyncLocalStorage).
        return getRequestContext().url.pathname;
      },
      { request: "https://app.test/checkout" },
    );
    expect(result).toBe("/checkout");
  });

  it("exposes fn's return value on `result` and passes the ctx arg", async () => {
    const { result } = await runInRequestContext((ctx) => ctx.cookies()["t"], {
      request: new Request("https://app.test/", {
        headers: { Cookie: "t=42" },
      }),
    });
    expect(result).toBe("42");
  });

  it("surfaces a Set-Cookie an action set on `response` and `cookies`", async () => {
    // The exact thing the action is testing — its cookie output — must be
    // observable without casting through @internal ctx.res / ctx.cookies().
    const { cookies: cookieView, response } = await runInRequestContext(() => {
      cookies().set("session", "new-token", { path: "/", httpOnly: true });
      return "ok";
    });

    // Effective cookie view: { name: value }.
    expect(cookieView.session).toBe("new-token");
    // Set-Cookie header on the accumulated response.
    const setCookie = response.headers.getSetCookie();
    expect(setCookie.some((c) => c.startsWith("session=new-token"))).toBe(true);
    expect(setCookie.some((c) => c.includes("HttpOnly"))).toBe(true);
  });

  it("merges request cookies with same-run mutations in `cookies`", async () => {
    const { cookies: cookieView } = await runInRequestContext(
      () => {
        cookies().set("theme", "dark");
        return null;
      },
      {
        request: new Request("https://app.test/", {
          headers: { Cookie: "sid=x" },
        }),
      },
    );
    // Request cookie preserved AND the run's mutation visible.
    expect(cookieView.sid).toBe("x");
    expect(cookieView.theme).toBe("dark");
  });

  it("surfaces location state an action set via `locationState` (post-action flash)", async () => {
    // A flash set with ctx.setLocationState(...) (or redirect({ state })) is
    // delivered to the client via the Flight payload; locationState makes it
    // assertable at the unit layer, resolved to the { key: value } the client reads.
    const { locationState } = await runInRequestContext((ctx) => {
      ctx.setLocationState({
        __rsc_ls_key: "flash",
        __rsc_ls_value: { text: "Saved!" },
      });
      return "saved";
    });
    expect(locationState).toEqual({ flash: { text: "Saved!" } });
  });

  it("returns an empty locationState when the run set none", async () => {
    const { locationState } = await runInRequestContext(() => "noop");
    expect(locationState).toEqual({});
  });

  it("surfaces response headers an action set via `headers`", async () => {
    const { headers, response } = await runInRequestContext((ctx) => {
      ctx.header("X-RateLimit-Remaining", "59");
      ctx.header("Cache-Control", "no-store");
      return "ok";
    });
    // Assertable as a plain object (names lowercased), like cookies/locationState.
    expect(headers["x-ratelimit-remaining"]).toBe("59");
    expect(headers["cache-control"]).toBe("no-store");
    // Consistent with the response view.
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("59");
  });

  it("excludes set-cookie from `headers` (it is on `cookies`)", async () => {
    const { headers, cookies: cookieView } = await runInRequestContext(() => {
      cookies().set("session", "tok", { path: "/" });
      return "ok";
    });
    expect(headers["set-cookie"]).toBeUndefined();
    expect(cookieView.session).toBe("tok");
  });

  it("captures a thrown redirect (the success path) with cookie + flash still observable", async () => {
    // The dominant case: an auth action sets a cookie + flash, then
    // `throw redirect(...)` on success. The snapshot must fire on the THROW path,
    // and the thrown redirect is captured (not re-thrown), so the consumer never
    // has to wrap the action in their own try/catch.
    const {
      result,
      thrown,
      response,
      cookies: cookieView,
      locationState,
    } = await runInRequestContext((ctx) => {
      cookies().set("session", "tok", { path: "/" });
      ctx.setLocationState({
        __rsc_ls_key: "flash",
        __rsc_ls_value: { text: "Welcome" },
      });
      throw redirect("/app");
    });

    expect(result).toBeUndefined();
    // The thrown redirect is observable on `thrown`.
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).headers.get("Location")).toBe("/app");
    // Cookie + flash set before the throw are still observable.
    expect(cookieView.session).toBe("tok");
    expect(locationState).toEqual({ flash: { text: "Welcome" } });
    // response merges the redirect's Location AND the accumulated Set-Cookie.
    expect(response.headers.get("Location")).toBe("/app");
    expect(
      response.headers.getSetCookie().some((c) => c.startsWith("session=tok")),
    ).toBe(true);
  });

  it("surfaces a thrown redirect's Location on `headers`", async () => {
    const { headers } = await runInRequestContext(() => {
      throw redirect("/app");
    });
    expect(headers.location).toBe("/app");
  });

  it("captures a non-Response throw on `thrown` without re-throwing", async () => {
    const err = new Error("boom");
    const {
      result,
      thrown,
      response,
      cookies: cookieView,
    } = await runInRequestContext(() => {
      cookies().set("partial", "x");
      throw err;
    });
    // Not re-thrown: the consumer asserts on `thrown` (no rejection).
    expect(result).toBeUndefined();
    expect(thrown).toBe(err);
    // Effects set before the throw are still observable; response is the stub snapshot.
    expect(cookieView.partial).toBe("x");
    expect(response.status).toBe(200);
  });

  it("does not leak the context outside the runner", async () => {
    await runInRequestContext(() => getRequestContext().method);
    expect(() => getRequestContext()).toThrow();
  });

  it("threads typed ctx.search into a loader invoked via ctx.use (action/dispatch path)", async () => {
    // A server action does `await ctx.use(ProductLoader)` where ProductLoader's
    // route declares a search schema. createUseFunction (the ctx.use behind
    // actions/dispatch) must build the loader's ctx.search by parsing the route's
    // search schema, matching the render and fetchable-loader paths — not hand it
    // an empty {} (which it did because the RequestContext has no `search` field).
    registerSearchSchema("products.list", { sort: "string?", page: "number?" });

    const ProductLoader = {
      $$id: "products.list#loader",
      fn: (ctx: any) => ctx.search,
    } as unknown as LoaderDefinition<Record<string, unknown>, any>;

    const { result } = await runInRequestContext(
      (ctx) => ctx.use(ProductLoader),
      {
        request: "https://app.test/products?sort=price&page=2",
        routeMap: { "products.list": "/products" },
        routeName: "products.list",
      },
    );

    expect(result).toEqual({ sort: "price", page: 2 });
  });

  it("gives a loader an empty ctx.search when the route has no search schema", async () => {
    const PlainLoader = {
      $$id: "plain#loader",
      fn: (ctx: any) => ctx.search,
    } as unknown as LoaderDefinition<Record<string, unknown>, any>;

    const { result } = await runInRequestContext(
      (ctx) => ctx.use(PlainLoader),
      {
        request: "https://app.test/plain?x=1",
        routeMap: { plain: "/plain" },
        routeName: "plain",
      },
    );

    expect(result).toEqual({});
  });
});

describe("runInRequestContext: invalidateClientCache / keepClientCache (action)", () => {
  // A server action is the canonical caller: invalidateClientCache() forces the
  // client's caches to miss (rotates the rango state cookie), keepClientCache()
  // suppresses the bridge's automatic invalidation (sets a directive header).
  // The state cookie name is always seeded, so the rotation fires like
  // production. These pin both as assertable through the run result.
  const stateCookies = (res: Response) =>
    res.headers.getSetCookie().filter((c) => c.startsWith("rango-state_"));

  it("an action calling invalidateClientCache() rotates the state cookie (one Set-Cookie, idempotent)", async () => {
    const { response, stateCookieName } = await runInRequestContext(() => {
      invalidateClientCache();
      invalidateClientCache();
      return "ok";
    });
    // result.stateCookieName surfaces the resolved name (assert without recomputing).
    expect(stateCookieName).toBe("rango-state_router_0");
    const cookies = stateCookies(response);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(
      /^rango-state_router_0=0:\d+; Path=\/; SameSite=Lax$/,
    );
    expect(cookies[0].startsWith(stateCookieName + "=")).toBe(true);
  });

  it("an action calling keepClientCache() sets the directive header and no cookie (idempotent)", async () => {
    const { headers, response } = await runInRequestContext(() => {
      keepClientCache();
      keepClientCache();
      return "ok";
    });
    expect(headers[KEEP_CACHE_HEADER]).toBe("1");
    // Headers.set (not append) -> one value even after two calls.
    expect(response.headers.get(KEEP_CACHE_HEADER)).toBe("1");
    expect(stateCookies(response)).toHaveLength(0);
  });

  it("keepClientCache() then invalidateClientCache(): the directive AND the rotation both land", async () => {
    // Mirrors the test-app's actionKeepThenInvalidate: an explicit invalidate
    // must still write its Set-Cookie even though keep was requested first.
    const { headers, response } = await runInRequestContext(() => {
      keepClientCache();
      invalidateClientCache();
      return "ok";
    });
    expect(headers[KEEP_CACHE_HEADER]).toBe("1");
    expect(stateCookies(response)).toHaveLength(1);
  });

  it("the stateCookie seed customizes the rotated name/version and the https Secure flag", async () => {
    const { response } = await runInRequestContext(
      () => {
        invalidateClientCache();
        return "ok";
      },
      {
        request: "https://app.test/checkout",
        stateCookie: { prefix: "myapp", routerId: "shop", version: "v9" },
      },
    );
    const [cookie] = response.headers
      .getSetCookie()
      .filter((c) => c.startsWith("myapp_shop="));
    // https request -> the Secure attribute is present.
    expect(cookie).toMatch(
      /^myapp_shop=v9:\d+; Path=\/; SameSite=Lax; Secure$/,
    );
  });

  it("merges the rotation Set-Cookie onto a thrown redirect (action success path)", async () => {
    // The dominant action shape: mutate, invalidate, then `throw redirect(...)`.
    // The redirect response must carry the rotation cookie.
    const { thrown, response } = await runInRequestContext(() => {
      invalidateClientCache();
      throw redirect("/app");
    });
    expect((thrown as Response).headers.get("Location")).toBe("/app");
    expect(response.headers.get("Location")).toBe("/app");
    expect(stateCookies(response)).toHaveLength(1);
  });

  // ctx.onResponse() is a documented public RequestContext method. Production
  // drains it on EVERY response-finalization path; the harness must too, or a
  // unit test for an action/handler that registers onResponse sees none of its
  // effects (dogfood-parity hazard). Covers both the normal-return path and the
  // throw-redirect path.
  it("runs an onResponse callback that mutates a header (normal return)", async () => {
    const { response, headers } = await runInRequestContext(() => {
      getRequestContext().onResponse((res) => {
        res.headers.set("X-Foo", "1");
        return res;
      });
      return "ok";
    });
    expect(response.headers.get("X-Foo")).toBe("1");
    expect(headers["x-foo"]).toBe("1");
  });

  it("honors an onResponse callback that returns a replacement Response", async () => {
    const { response } = await runInRequestContext(() => {
      getRequestContext().onResponse(
        () => new Response(null, { status: 418, headers: { "X-Teapot": "1" } }),
      );
      return "ok";
    });
    expect(response.status).toBe(418);
    expect(response.headers.get("X-Teapot")).toBe("1");
  });

  it("runs an onResponse callback on the throw-redirect path", async () => {
    const { response } = await runInRequestContext(() => {
      getRequestContext().onResponse((res) => {
        res.headers.set("X-Flash", "saved");
        return res;
      });
      throw redirect("/app");
    });
    expect(response.headers.get("Location")).toBe("/app");
    expect(response.headers.get("X-Flash")).toBe("saved");
  });
});

describe("runWithRequestContext re-export", () => {
  it("enters a ctx built with createTestRequestContext (the low-level path)", () => {
    const { ctx } = createTestRequestContext({
      request: new Request("https://app.test/", {
        headers: { Cookie: "sid=zzz" },
      }),
    });
    const sid = runWithRequestContext(
      ctx,
      () => getRequestContext().cookies()["sid"],
    );
    expect(sid).toBe("zzz");
  });

  it("ctx.reverse accepts a local routeMap name without a cast (T8)", () => {
    // The returned ctx.reverse is typed (TestRequestContextObject) against the
    // routeMap you pass, NOT the global Rango.GeneratedRouteMap — so reversing a
    // test-only route name type-checks (pre-T8 it errored and forced a cast).
    // This call compiling is itself the assertion; the value confirms runtime.
    const { ctx } = createTestRequestContext({
      routeMap: { "test-only": "/t/:id" },
    });
    expect(ctx.reverse("test-only", { id: "9" })).toBe("/t/9");
  });
});
