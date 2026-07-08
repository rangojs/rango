// Tests renderHandler: run real route handlers with seeded context and assert RSC output + effects.
import { describe, expect, test } from "vitest";
import { findClientBoundaries, renderHandler } from "../flight.entry.js";
import { createVar } from "../../context-var.js";
import { createLoader } from "../../loader.js";
import { Meta } from "../../handles/meta.js";
import { Breadcrumbs } from "../../handles/breadcrumbs.js";
import { redirect } from "../../route-definition/redirect.js";
import {
  invalidateClientCache,
  keepClientCache,
} from "../../server/cookie-store.js";
import { KEEP_CACHE_HEADER } from "../../browser/cookie-name.js";
import { Counter } from "./fixtures/Counter.js";
import { getRequestContext } from "../../server/request-context.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import type { HandlerContext } from "../../types/handler-context.js";

const Tenant = createVar<{ name: string }>();
const ProductLoader = createLoader(async () => ({ name: "Wine", price: 9 }));

describe("renderHandler", () => {
  test("runs a real handler: params + ctx.use(Loader) + ctx.get + renders RSC", async () => {
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

  test("ctx.dynamic() + ctx.headers.set() compose in one handler (#735 markSfraProxy collapse)", async () => {
    // The consumer collapse from issue #735: a dynamic() route can write its
    // control-flow header straight from the handler (no middleware relay). Both
    // effects are observable through the public primitive — result.dynamic AND
    // the header on result.headers. (The ppr-latch re-permit itself is pinned at
    // the unit seam + dev/prod e2e; renderHandler runs no funnel latch.)
    function SfraProxyPage(ctx: HandlerContext) {
      ctx.dynamic();
      ctx.headers.set("x-rango-sfra-proxy", "catalog");
      return <div>proxied</div>;
    }

    const { dynamic, headers } = await renderHandler(SfraProxyPage);
    expect(dynamic).toBe(true);
    expect(headers["x-rango-sfra-proxy"]).toBe("catalog");
  });

  test("seeded ctx.use(Loader) returns a Promise (production parity)", async () => {
    // Production ctx.use(Loader) ALWAYS returns a Promise. The seeded harness
    // path must too, so a handler composing on the result (.then/Promise.race)
    // behaves the same as in a real render. Before the fix it returned the raw
    // value, so `.then` was undefined.
    async function Page(ctx: HandlerContext) {
      const used = ctx.use(ProductLoader);
      const isThenable =
        used instanceof Promise && typeof used.then === "function";
      const product = await used;
      // Compose the marker into a single string so it serializes contiguously
      // (Flight splits `{a}{b}` JSX into a children array, not one string).
      const marker = `thenable=${isThenable}:name=${product.name}`;
      return <main>{marker}</main>;
    }
    const { tree } = await renderHandler(Page, {
      loaders: [[ProductLoader, { name: "Wine", price: 9 }]],
    });
    expect(JSON.stringify(tree)).toContain("thenable=true:name=Wine");
  });

  // #582 parity: renderHandler scopes the request-context reverse to the
  // routeMap option (not only the handler context), so a NESTED server component
  // reading getRequestContext().reverse() resolves against the same map as the
  // handler's ctx.reverse -- consistent with renderToFlightString/renderServerTree.
  test("a nested server component's getRequestContext().reverse scopes to the routeMap option", async () => {
    async function NestedReverse() {
      const ctx = getRequestContext();
      return <a href={ctx.reverse("product", { id: "9" })}>go</a>;
    }
    function Page() {
      return (
        <main>
          <NestedReverse />
        </main>
      );
    }
    const { tree } = await renderHandler(Page, {
      routeMap: { product: "/scoped/products/:id" },
    });
    expect(JSON.stringify(tree)).toContain("/scoped/products/9");
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
    function Page(): never {
      throw new Error(
        `cookies() is only available from "@rangojs/router" in a react-server/RSC environment.`,
      );
    }
    await expect(renderHandler(Page)).rejects.toThrow(/rangoTestAliases/);
  });

  test("a normal handler throw is captured on result.thrown, NOT reclassified as setup", async () => {
    const boom = new Error("boom from handler");
    function Page(): never {
      throw boom;
    }
    const { thrown, tree } = await renderHandler(Page);
    expect(thrown).toBe(boom);
    expect(tree).toBeUndefined();
  });

  test("a handler that RETURNS a Response preserves its body (response route)", async () => {
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

describe("renderHandler: ctx.use(Handle).defer()", () => {
  // The push returned by ctx.use(Handle) carries `.defer()` in production
  // (request-context.ts / loader-resolution.ts wrap it with withDefer). The
  // harness wraps its recording push the same way, so a consumer can unit-test
  // the deferred-handle feature without an e2e. The reserved slot is recorded as
  // the pending Promise; settling/timeout is observable by awaiting it.
  test("exposes .defer() on the push, matching the production shape", async () => {
    // Capture the push and assert AFTER renderHandler resolves: an expect()
    // thrown inside the handler is captured on result.thrown, not re-thrown, so
    // an in-handler assertion would pass vacuously.
    let crumb: { defer?: unknown } | undefined;
    function Page(ctx: HandlerContext) {
      crumb = ctx.use(Breadcrumbs);
      return <main>ok</main>;
    }
    await renderHandler(Page);
    expect(typeof crumb?.defer).toBe("function");
  });

  test("a deep async component resolves the reserved slot (decide-sync, resolve-late)", async () => {
    function Page(ctx: HandlerContext) {
      // Decide to push now (slot reserved before render); resolve from a deep
      // async child via the push-equal resolver.
      const resolve = ctx
        .use(Breadcrumbs)
        .defer({ timeoutMs: 5000, else: null });
      async function Deep() {
        await Promise.resolve();
        resolve({ label: "Deferred", href: "/deferred" });
        return <span>deep-done</span>;
      }
      return (
        <main>
          <Deep />
        </main>
      );
    }
    const { handles, tree } = await renderHandler(Page);
    // The deep component rendered (the resolver ran during serialization).
    expect(JSON.stringify(tree)).toContain("deep-done");
    // The reserved slot was recorded as a Promise and settled to the deep value.
    const [slot] = handles.get(Breadcrumbs) ?? [];
    expect(slot).toBeInstanceOf(Promise);
    expect(await slot).toEqual({ label: "Deferred", href: "/deferred" });
  });

  test("the resolver is push-equal: accepts a Promise argument", async () => {
    function Page(ctx: HandlerContext) {
      const resolve = ctx.use(Breadcrumbs).defer();
      resolve(Promise.resolve({ label: "Async", href: "/async" }));
      return <main>ok</main>;
    }
    const { handles } = await renderHandler(Page);
    const [slot] = handles.get(Breadcrumbs) ?? [];
    expect(await slot).toEqual({ label: "Async", href: "/async" });
  });

  test("the resolver is push-equal: invokes a thunk immediately", async () => {
    let called = false;
    function Page(ctx: HandlerContext) {
      const resolve = ctx.use(Breadcrumbs).defer();
      resolve(() => {
        called = true;
        return Promise.resolve({ label: "Thunk", href: "/thunk" });
      });
      return <main>ok</main>;
    }
    const { handles } = await renderHandler(Page);
    expect(called).toBe(true);
    const [slot] = handles.get(Breadcrumbs) ?? [];
    expect(await slot).toEqual({ label: "Thunk", href: "/thunk" });
  });

  test("a never-resolved slot falls back to `else` on the timeout (no hang)", async () => {
    // The safety net: a reserved slot whose resolver is never called must
    // auto-resolve to `else` so the response can flush instead of hanging on the
    // open Flight row. renderHandler returning at all proves no hang. (The dev
    // warn is environment-dependent and pinned in defer.test.ts; the rsc project
    // runs NODE_ENV=production, so only the fallback resolution is asserted here.)
    function Page(ctx: HandlerContext) {
      ctx.use(Breadcrumbs).defer({
        timeoutMs: 10,
        else: { label: "Forgotten", href: "/forgotten" },
      });
      // Resolver intentionally never called.
      return <main>ok</main>;
    }
    const { handles, tree } = await renderHandler(Page);
    expect(JSON.stringify(tree)).toContain("ok");
    const [slot] = handles.get(Breadcrumbs) ?? [];
    expect(slot).toBeInstanceOf(Promise);
    expect(await slot).toEqual({ label: "Forgotten", href: "/forgotten" });
  });

  test('forwards cacheStore/cacheProfiles into the request context (so "use cache" does not bypass)', async () => {
    // Dogfood the new renderHandler { cacheStore, cacheProfiles } options. The
    // bypass-vs-cached decision in registerCachedFunction keys on
    // requestCtx._cacheStore, so asserting the options reach it proves a handler
    // invoking a "use cache" fn would take the cached path instead of the
    // (warned) uncached bypass. (The bypass/warn behavior itself is pinned in
    // cache/__tests__/cache-runtime-stale.test.ts, where @vitejs/plugin-rsc/rsc
    // is mocked; it is not resolvable in a bare worker.)
    const store = new MemorySegmentCacheStore();
    function Page() {
      const ctx = getRequestContext() as unknown as {
        _cacheStore?: unknown;
        _cacheProfiles?: Record<string, unknown>;
      };
      const hasStore = ctx._cacheStore === store;
      const hasProfile = Boolean(ctx._cacheProfiles?.fast);
      return <main>{`store=${hasStore} profile=${hasProfile}`}</main>;
    }
    const { tree } = await renderHandler(Page, {
      cacheStore: store,
      cacheProfiles: { fast: { ttl: 60 } },
    });
    expect(JSON.stringify(tree)).toContain("store=true profile=true");
  });

  test("inActionRevalidation option marks the request context (foregroundOnAction gate input)", async () => {
    // The `foregroundOnAction` cache profile foregrounds a stale entry only when
    // requestCtx._inActionRevalidation is set (production sets it in
    // revalidateAfterAction). This dogfoods the new renderHandler option and
    // pins that it reaches that exact field, so a consumer can drive the
    // foregroundOnAction path from a test. The foreground-vs-SWR decision the
    // field gates is pinned in cache/__tests__/cache-runtime-stale.test.ts (where
    // @vitejs/plugin-rsc/rsc is mocked, since cache-runtime is not importable in
    // this bare react-server worker).
    function Page() {
      const ctx = getRequestContext() as unknown as {
        _inActionRevalidation?: boolean;
      };
      return (
        <main>{`actionRevalidation=${ctx._inActionRevalidation === true}`}</main>
      );
    }
    const on = await renderHandler(Page, { inActionRevalidation: true });
    expect(JSON.stringify(on.tree)).toContain("actionRevalidation=true");
    // Default (a plain render / navigation): the flag is unset, so a stale entry
    // would keep SWR.
    const off = await renderHandler(Page);
    expect(JSON.stringify(off.tree)).toContain("actionRevalidation=false");
  });

  // Dogfood ctx.theme / ctx.setTheme — documented HandlerContext members. The
  // theme option resolves a ThemeConfig and seeds it into the request context;
  // ctx.setTheme writes the theme cookie (default storageKey "theme"), captured
  // in the run's cookie snapshot.
  test("theme option enables ctx.theme and ctx.setTheme writes the cookie", async () => {
    let observed: string | undefined;
    function Page(ctx: HandlerContext) {
      observed = ctx.theme;
      ctx.setTheme?.("dark");
      return <main>ok</main>;
    }
    const { cookies, response } = await renderHandler(Page, { theme: true });
    // Default theme is "system".
    expect(observed).toBe("system");
    expect(cookies.theme).toBe("dark");
    expect(
      response.headers.getSetCookie().some((c) => c.startsWith("theme=dark")),
    ).toBe(true);
  });

  test("ctx.theme reflects an incoming theme cookie", async () => {
    let observed: string | undefined;
    function Page(ctx: HandlerContext) {
      observed = ctx.theme;
      return <main>ok</main>;
    }
    await renderHandler(Page, {
      theme: true,
      headers: { Cookie: "theme=dark" },
    });
    expect(observed).toBe("dark");
  });

  test("ctx.theme / ctx.setTheme are inert without the theme option", async () => {
    let observed: string | undefined = "unset";
    let hadSetter = true;
    function Page(ctx: HandlerContext) {
      observed = ctx.theme;
      hadSetter = typeof ctx.setTheme === "function";
      ctx.setTheme?.("dark");
      return <main>ok</main>;
    }
    const { cookies } = await renderHandler(Page);
    expect(observed).toBeUndefined();
    expect(hadSetter).toBe(false);
    expect(cookies.theme).toBeUndefined();
  });

  test("ctx.build reflects opts.build and ctx.dynamic() surfaces on result.dynamic", async () => {
    // A handler branching on ctx.build (the build-time PPR pass) and opting the
    // request out of shell capture on a MISS must be unit-testable through the
    // public primitive; result.dynamic surfaces the opt-out without reading the
    // @internal ctx._dynamic.
    let observedBuild: boolean | undefined;
    function Page(ctx: HandlerContext) {
      observedBuild = ctx.build;
      if (ctx.build) ctx.dynamic();
      return <main>ok</main>;
    }

    const built = await renderHandler(Page, { build: true });
    expect(observedBuild).toBe(true);
    expect(built.dynamic).toBe(true);

    const live = await renderHandler(Page, {});
    expect(observedBuild).toBe(false);
    expect(live.dynamic).toBe(false);
  });
});
