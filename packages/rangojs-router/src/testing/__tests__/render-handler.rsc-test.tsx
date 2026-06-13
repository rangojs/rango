// renderHandler: run a REAL route handler (a pure function `(ctx) => rsc`, what
// you pass to path(...)) with a seeded HandlerContext, then assert the RSC it
// renders + the effects it produced. Runs in the rsc project (react-server).
import { describe, expect, test } from "vitest";
import { findClientBoundaries, renderHandler } from "../flight.entry.js";
import { createVar } from "../../context-var.js";
import { createLoader } from "../../loader.js";
import { Meta } from "../../handles/meta.js";
import { redirect } from "../../route-definition/redirect.js";
import {
  invalidateClientCache,
  keepClientCache,
} from "../../server/cookie-store.js";
import { KEEP_CACHE_HEADER } from "../../browser/cookie-name.js";
import { Counter } from "./fixtures/Counter.js";
import type { HandlerContext } from "../../types/handler-context.js";

const Tenant = createVar<{ name: string }>();
const ProductLoader = createLoader(async () => ({ name: "Wine", price: 9 }));

describe("renderHandler", () => {
  test("runs a real handler: params + ctx.use(Loader) + ctx.get + renders RSC", async () => {
    // The handler is a pure function (ctx) => rsc — exactly as authored for path().
    async function ProductPage(ctx: HandlerContext<{ slug: string }>) {
      const product = await ctx.use(ProductLoader);
      const tenant = ctx.get(Tenant);
      return (
        <main>
          <h1>
            {tenant?.name}: {product.name}
          </h1>
          <p>slug: {ctx.params.slug}</p>
          <span>${product.price}</span>
        </main>
      );
    }

    const { tree, flight } = await renderHandler(ProductPage, {
      params: { slug: "wine" },
      loaders: [[ProductLoader, { name: "Wine", price: 9 }]],
      vars: [[Tenant, { name: "Acme" }]],
    });

    expect(flight).toBeDefined();
    const json = JSON.stringify(tree);
    expect(json).toContain("Acme");
    expect(json).toContain("Wine");
    expect(json).toContain("wine"); // the slug param
    expect(json).toContain("9");
  });

  test("captures handle pushes (ctx.use(Meta)) without crashing", async () => {
    function Page(ctx: HandlerContext) {
      const meta = ctx.use(Meta);
      meta({ title: "Product - Shop" });
      return <main>ok</main>;
    }
    const { handles, tree } = await renderHandler(Page);
    expect(JSON.stringify(tree)).toContain("ok");
    expect(handles.get(Meta)).toEqual([{ title: "Product - Shop" }]);
  });

  test("a handler's client island crosses the boundary and props are typed", async () => {
    function Page(ctx: HandlerContext<{ start: string }>) {
      return (
        <main>
          <Counter
            start={Number(ctx.params.start)}
            when={new Date(0)}
            tags={new Map()}
          />
        </main>
      );
    }
    const { tree } = await renderHandler(Page, {
      params: { start: "7" },
      clientComponents: { Counter },
    });
    const [counter] = findClientBoundaries(tree, "Counter");
    expect(counter.props.start).toBe(7);
    expect(counter.props.when).toBeInstanceOf(Date);
  });

  test("a handler that sets a header/flash then redirects: effects + thrown", async () => {
    function LoginAction(ctx: HandlerContext): never {
      ctx.headers.set("X-Auth", "ok");
      ctx.setLocationState([
        { __rsc_ls_key: "flash", __rsc_ls_value: { text: "Welcome" } },
      ]);
      throw redirect("/app");
    }
    const { thrown, tree, response, headers, locationState } =
      await renderHandler(LoginAction);

    expect(tree).toBeUndefined(); // returned a Response, not RSC
    expect(thrown).toBeInstanceOf(Response);
    expect(response.headers.get("Location")).toBe("/app");
    expect(headers.location).toBe("/app");
    expect(headers["x-auth"]).toBe("ok");
    expect(locationState).toEqual({ flash: { text: "Welcome" } });
  });

  test("an unseeded ctx.use(loader) throws a helpful error", async () => {
    function Page(ctx: HandlerContext) {
      ctx.use(ProductLoader); // not seeded
      return <main />;
    }
    await expect(renderHandler(Page)).rejects.toThrow(/was not seeded/i);
  });

  test("rethrows an actionable error when the handler hits the server-only stub (missing rsc alias)", async () => {
    // Simulate the out-of-react-server stub throw a handler would hit if the
    // vitest.rsc.config.ts resolve.alias does not map bare @rangojs/router to
    // index.rsc.ts. renderHandler must surface it LOUDLY (not swallow it into
    // result.thrown as an opaque tree:undefined).
    function Page(): never {
      throw new Error(
        `cookies() is only available from "@rangojs/router" in a react-server/RSC environment.`,
      );
    }
    await expect(renderHandler(Page)).rejects.toThrow(/rangoTestAliases/);
  });

  test("a normal handler throw is captured on result.thrown, NOT reclassified as setup", async () => {
    // Control: an ordinary Error must stay observable on result.thrown (no
    // false-positive from the server-only-stub guard).
    const boom = new Error("boom from handler");
    function Page(): never {
      throw boom;
    }
    const { thrown, tree } = await renderHandler(Page);
    expect(thrown).toBe(boom);
    expect(tree).toBeUndefined();
  });

  test("a handler that RETURNS a Response preserves its body (response route)", async () => {
    // The documented response-route case: a handler returns
    // `new Response(JSON.stringify(...))`. Pre-fix buildResponse rewrapped to
    // `new Response(null, ...)` and the body was lost; now it is carried over so
    // `await result.response.text()`/`.json()` works.
    function Health(): Response {
      return new Response(JSON.stringify({ ok: true, count: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const { tree, response } = await renderHandler(Health);
    expect(tree).toBeUndefined(); // a Response, not RSC
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe('{"ok":true,"count":2}');
  });

  test("a returned Response body survives alongside a handler-set cookie", async () => {
    // The stub-cookie merge must not clobber the carried-over body.
    function Page(ctx: HandlerContext): Response {
      ctx.headers.set("X-Trace", "abc");
      return new Response("plain body", {
        status: 201,
        headers: { "content-type": "text/plain" },
      });
    }
    const { response, headers } = await renderHandler(Page);
    expect(response.status).toBe(201);
    expect(headers["x-trace"]).toBe("abc");
    expect(await response.text()).toBe("plain body");
  });

  test("ctx.use(Handle)(() => value) records the EVALUATED value, not the function", async () => {
    // Production's push fn CALLS a function argument and pushes its RESULT
    // (loader-resolution.ts). The harness must mirror it, so the function form
    // (the typed signature is `() => Promise<...>`) yields the awaited value in
    // result.handles, not a raw `[Function]`. Pre-fix the function itself was
    // recorded.
    function Page(ctx: HandlerContext) {
      const meta = ctx.use(Meta);
      meta(async () => ({ title: "Computed Title" }));
      return <main>ok</main>;
    }
    const { handles } = await renderHandler(Page);
    const [pushed] = handles.get(Meta) ?? [];
    // The fix: the callback was invoked. Pre-fix `pushed` would be the function.
    expect(typeof pushed).not.toBe("function");
    expect(pushed).toBeInstanceOf(Promise); // an async callback records its promise
    expect(await pushed).toEqual({ title: "Computed Title" });
  });

  test("throws a migration error for the legacy { request -> url } rename", async () => {
    // { url } was renamed to { request }. A plain-JS / spread-defeated consumer
    // still passing it would otherwise render against the default origin.
    function Page() {
      return <main />;
    }
    await expect(
      // @ts-expect-error legacy option removed; runtime guard catches it.
      renderHandler(Page, { url: "/legacy" }),
    ).rejects.toThrow(/`url` option was renamed to `request`/);
  });
});

describe("renderHandler: invalidateClientCache / keepClientCache", () => {
  // The state cookie name is always seeded (default rango-state_router_0), so a
  // handler that calls invalidateClientCache() rotates and emits the Set-Cookie
  // exactly like production instead of silently no-opping. These pin that the
  // rotation is assertable through result.response / result.headers.
  // The default request is http://localhost/, so the regex deliberately has NO
  // `; Secure` (the https case is covered in run-in-request-context.test.ts).
  const STATE_RE = /^rango-state_router_0=0:\d+; Path=\/; SameSite=Lax$/;
  const stateCookies = (res: Response) =>
    res.headers.getSetCookie().filter((c) => c.startsWith("rango-state_"));

  test("a handler calling invalidateClientCache() emits one rotation Set-Cookie", async () => {
    function Page() {
      invalidateClientCache();
      return <main>ok</main>;
    }
    const { response, tree, stateCookieName } = await renderHandler(Page);
    expect(JSON.stringify(tree)).toContain("ok");
    // result.stateCookieName surfaces the resolved name (assert without recomputing).
    expect(stateCookieName).toBe("rango-state_router_0");
    const cookies = stateCookies(response);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(STATE_RE);
    expect(cookies[0].startsWith(stateCookieName + "=")).toBe(true);
  });

  test("invalidateClientCache() is idempotent within a request (one Set-Cookie even if called twice)", async () => {
    function Page() {
      invalidateClientCache();
      invalidateClientCache();
      return <main>ok</main>;
    }
    const { response } = await renderHandler(Page);
    expect(stateCookies(response)).toHaveLength(1);
  });

  test("a handler that does NOT invalidate emits no rango-state Set-Cookie (seeding alone never rotates)", async () => {
    function Page() {
      return <main>ok</main>;
    }
    const { response } = await renderHandler(Page);
    expect(stateCookies(response)).toHaveLength(0);
  });

  test("stateCookie seed customizes the rotated cookie's name and version", async () => {
    function Page() {
      invalidateClientCache();
      return <main>ok</main>;
    }
    const { response, stateCookieName } = await renderHandler(Page, {
      stateCookie: { prefix: "myapp", routerId: "shop", version: "v3" },
    });
    expect(stateCookieName).toBe("myapp_shop");
    const [cookie] = response.headers
      .getSetCookie()
      .filter((c) => c.startsWith("myapp_shop="));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/^myapp_shop=v3:\d+; Path=\/; SameSite=Lax$/);
  });

  test("keepClientCache() sets the x-rango-keep-cache directive header and no cookie", async () => {
    function Page() {
      keepClientCache();
      return <main>ok</main>;
    }
    const { headers, response } = await renderHandler(Page);
    expect(headers[KEEP_CACHE_HEADER]).toBe("1");
    expect(stateCookies(response)).toHaveLength(0);
  });

  test("keepClientCache() is idempotent within a request (one directive header even if called twice)", async () => {
    // _setKeepCacheDirective uses Headers.set (not append), so repeated calls
    // collapse to one value — mirror the invalidateClientCache idempotency pin.
    function Page() {
      keepClientCache();
      keepClientCache();
      return <main>ok</main>;
    }
    const { headers, response } = await renderHandler(Page);
    expect(headers[KEEP_CACHE_HEADER]).toBe("1");
    // No duplicate header value (a plain object collapses, so check the raw header).
    expect(response.headers.get(KEEP_CACHE_HEADER)).toBe("1");
  });

  test("keepClientCache() then invalidateClientCache(): the directive AND the rotation both land", async () => {
    // The keep directive and an explicit rotation are independent server-side
    // effects (the bridge resolves precedence on the client). Both must be
    // observable so a consumer can pin the action wrote both.
    function Page() {
      keepClientCache();
      invalidateClientCache();
      return <main>ok</main>;
    }
    const { headers, response } = await renderHandler(Page);
    expect(headers[KEEP_CACHE_HEADER]).toBe("1");
    expect(stateCookies(response)).toHaveLength(1);
  });

  test("a handler returning a Response while invalidating: the rotation Set-Cookie merges onto it", async () => {
    // A response route (returns a Response) can still rotate; buildResponse must
    // carry the stub's Set-Cookie onto the returned Response (and its body).
    function Page(): Response {
      invalidateClientCache();
      return new Response("done", { status: 202 });
    }
    const { response } = await renderHandler(Page);
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("done");
    expect(stateCookies(response)).toHaveLength(1);
  });
});
