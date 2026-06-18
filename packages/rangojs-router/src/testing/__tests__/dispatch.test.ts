import { describe, it, expect, vi } from "vitest";

// createRouter's match path transitively imports @vitejs/plugin-rsc/rsc, whose
// top-level body imports Vite virtual modules that do not resolve in plain
// node/vitest. dispatch() itself never renders RSC, so a stub is sufficient.
vi.mock("@vitejs/plugin-rsc/rsc", () => ({
  createFromReadableStream: vi.fn(),
  renderToReadableStream: vi.fn(),
  loadServerAction: vi.fn(),
  decodeReply: vi.fn(),
  decodeAction: vi.fn(),
  decodeFormState: vi.fn(),
  createTemporaryReferenceSet: vi.fn(),
}));

import { dispatch } from "../dispatch.js";
import { createRouter } from "../../router.js";
import { redirect } from "../../route-definition/redirect.js";
import { urls } from "../../urls/urls-function.js";
import { cookies } from "../../server/cookie-store.js";
import { getRequestContext } from "../../server/request-context.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import { RouterError } from "../../errors.js";
import type { MiddlewareFn } from "../../router/middleware.js";

function Home() {
  return null;
}

function buildRouter() {
  return createRouter<{ region?: string }>({}).routes(
    urls(({ path }) => [
      path("/", Home, { name: "home" }),
      path.json("/api/data", () => ({ hello: "world" }), { name: "api.data" }),
      path.json(
        "/api/echo/:id",
        (ctx: { params: { id: string } }) => ({ id: ctx.params.id }),
        { name: "api.echo" },
      ),
      path.text("/api/ping", () => "pong", { name: "api.ping" }),
      path("/old/", Home, { name: "old", trailingSlash: "always" }),
    ]),
  ) as any;
}

describe("dispatch", () => {
  it("serializes a JSON response route (bare value, no envelope)", async () => {
    const router = buildRouter();
    const res = await dispatch(router, { request: "/api/data" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/json;charset=utf-8",
    );
    expect(await res.json()).toEqual({ hello: "world" });
  });

  it("drains ctx.onResponse() callbacks like production finalization", async () => {
    // A response route that registers an onResponse hook and sets a status via
    // the request context. dispatch routes the serialized response through the
    // real createResponseWithMergedHeaders, so the hook must fire and the
    // ctx.setStatus override must win — exactly as in production.
    const router = createRouter<{}>({}).routes(
      urls(({ path }) => [
        path.json(
          "/api/hooked",
          () => {
            const ctx = getRequestContext();
            ctx.setStatus(201);
            ctx.onResponse((res) => {
              res.headers.set("x-on-response", "ran");
              return res;
            });
            return { ok: true };
          },
          { name: "api.hooked" },
        ),
      ]),
    ) as any;

    const res = await dispatch(router, { request: "/api/hooked" });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-on-response")).toBe("ran");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("passes route params to a response-route handler", async () => {
    const router = buildRouter();
    const res = await dispatch(router, { request: "/api/echo/42" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "42" });
  });

  it("serializes a text response route", async () => {
    const router = buildRouter();
    const res = await dispatch(router, { request: "/api/ping" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain;charset=utf-8");
    expect(await res.text()).toBe("pong");
  });

  it("emits a 308 redirect for a trailing-slash mismatch", async () => {
    const router = buildRouter();
    const res = await dispatch(router, { request: "/old" });

    expect(res.status).toBe(308);
    expect(res.headers.get("Location")).toBe("/old/");
  });

  it("preserves the query string on a redirect", async () => {
    const router = buildRouter();
    const res = await dispatch(router, { request: "/old?ref=email" });

    expect(res.status).toBe(308);
    expect(res.headers.get("Location")).toBe("/old/?ref=email");
  });

  it("returns 404 for an unmatched path", async () => {
    const router = buildRouter();
    const res = await dispatch(router, { request: "/nope" });

    expect(res.status).toBe(404);
  });

  it("builds ctx.reverse WITHOUT auto-filling the matched route's params (production parity)", async () => {
    // Production's response-route handler builds reverse from the route map
    // alone (no matched params). dispatch must match: reversing the current
    // :id route with no explicit params must NOT silently produce the request
    // URL, or a test would pass where the real handler throws/500s.
    const router = createRouter<{}>({}).routes(
      urls(({ path }) => [
        path.json(
          "/api/self/:id",
          (ctx: { reverse: (n: string) => string }) => {
            try {
              return { reversed: ctx.reverse("api.self") };
            } catch (e) {
              return { error: (e as Error).message };
            }
          },
          { name: "api.self" },
        ),
      ]),
    ) as Parameters<typeof dispatch>[0];

    const res = await dispatch(router, { request: "/api/self/42" });
    const body = (await res.json()) as { reversed?: string; error?: string };
    // Pin the exact production behavior: with no explicit params the :id segment
    // is left unsubstituted (the raw pattern), NOT auto-filled from the request.
    expect(body.reversed).toBe("/api/self/:id");
    expect(body.error).toBeUndefined();
  });

  it("short-circuits a partial (_rsc_partial) request to X-RSC-Reload without running the handler", async () => {
    let handlerRan = false;
    const router = createRouter<{}>({}).routes(
      urls(({ path }) => [
        path.json(
          "/api/data",
          () => {
            handlerRan = true;
            return { hello: "world" };
          },
          { name: "api.data" },
        ),
      ]),
    ) as Parameters<typeof dispatch>[0];

    const res = await dispatch(router, { request: "/api/data?_rsc_partial=1" });
    expect(res.status).toBe(200);
    const reload = res.headers.get("X-RSC-Reload");
    // Full URL with the internal _rsc_partial param stripped (production parity).
    expect(reload).toContain("/api/data");
    expect(reload).not.toContain("_rsc_partial");
    expect(res.headers.get("content-type")).toContain("text/x-component");
    expect(handlerRan).toBe(false);
  });

  it("runs GLOBAL middleware BEFORE the partial short-circuit (an auth gate still blocks a partial)", async () => {
    // Production wraps coreHandler (which holds the _rsc_partial short-circuit)
    // with global middleware (handler.ts:481-489), so a global auth middleware
    // runs first and can 401/redirect a partial request. dispatch must match,
    // or a consumer test of "my middleware blocks partial requests" falsely
    // passes (the bug: dispatch used to return X-RSC-Reload before any
    // middleware ran). This test fails on the pre-fix code.
    let globalRan = false;
    let handlerRan = false;
    const authMw: MiddlewareFn = async () => {
      globalRan = true;
      return new Response(null, { status: 401 });
    };
    const router = createRouter<{}>({})
      .use(authMw)
      .routes(
        urls(({ path }) => [
          path.json(
            "/api/data",
            () => {
              handlerRan = true;
              return { hello: "world" };
            },
            { name: "api.data" },
          ),
        ]),
      ) as Parameters<typeof dispatch>[0];

    const res = await dispatch(router, { request: "/api/data?_rsc_partial=1" });
    expect(globalRan).toBe(true);
    expect(res.status).toBe(401);
    expect(res.headers.get("X-RSC-Reload")).toBeNull();
    expect(handlerRan).toBe(false);
  });

  it("emits X-RSC-Reload (not the handler) when global middleware passes a partial through", async () => {
    let globalRan = false;
    let handlerRan = false;
    const tagMw: MiddlewareFn = async (ctx, next) => {
      globalRan = true;
      ctx.header("X-Tag", "yes");
      return next();
    };
    const router = createRouter<{}>({})
      .use(tagMw)
      .routes(
        urls(({ path }) => [
          path.json(
            "/api/data",
            () => {
              handlerRan = true;
              return { hello: "world" };
            },
            { name: "api.data" },
          ),
        ]),
      ) as Parameters<typeof dispatch>[0];

    const res = await dispatch(router, { request: "/api/data?_rsc_partial=1" });
    expect(globalRan).toBe(true);
    // The handler never runs on a partial — the reload IS the terminal handler.
    expect(handlerRan).toBe(false);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RSC-Reload")).toContain("/api/data");
    // Global middleware header effects still merge onto the reload response.
    expect(res.headers.get("X-Tag")).toBe("yes");
  });

  // A1 makes `router.use("/:locale(en|gb)/*", mw)` a real consumer feature:
  // constrained / optional / suffix middleware scopes. Exercise it end-to-end
  // through dispatch (the public testing primitive that runs the full global
  // middleware scope-matching path), not just the white-box compiler, so a
  // consumer can pin "my scoped middleware runs only for these locales".
  describe("constrained middleware scope (router.use)", () => {
    function localeScopedRouter(onRun: (locale: string) => void) {
      const localeMw: MiddlewareFn = async (ctx, next) => {
        onRun(ctx.params.locale as string);
        ctx.header("X-Locale-Mw", "ran");
        return next();
      };
      return createRouter<{}>({})
        .use("/:locale(en|gb)/*", localeMw)
        .routes(
          urls(({ path }) => [
            path.json("/en/x", () => ({ ok: "en" }), { name: "en.x" }),
            path.json("/gb/x", () => ({ ok: "gb" }), { name: "gb.x" }),
            path.json("/de/x", () => ({ ok: "de" }), { name: "de.x" }),
          ]),
        ) as Parameters<typeof dispatch>[0];
    }

    it("runs the middleware for an in-constraint locale (/en) and exposes the param", async () => {
      const ran: string[] = [];
      const res = await dispatch(
        localeScopedRouter((l) => ran.push(l)),
        {
          request: "/en/x",
        },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Locale-Mw")).toBe("ran");
      // The constrained param is named "locale" (not "locale(en|gb)") and is
      // extracted from the matched path.
      expect(ran).toEqual(["en"]);
    });

    it("runs the middleware for the other in-constraint locale (/gb)", async () => {
      const ran: string[] = [];
      const res = await dispatch(
        localeScopedRouter((l) => ran.push(l)),
        {
          request: "/gb/x",
        },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Locale-Mw")).toBe("ran");
      expect(ran).toEqual(["gb"]);
    });

    it("does NOT run the middleware for an out-of-constraint locale (/de)", async () => {
      // The whole point of the constraint: /de is a real route but is outside
      // the (en|gb) scope, so the middleware must not run. If constraints were
      // not enforced (the pre-A1 bug, or a scope-explosion regression) the
      // middleware would run here and this test would fail.
      const ran: string[] = [];
      const res = await dispatch(
        localeScopedRouter((l) => ran.push(l)),
        {
          request: "/de/x",
        },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Locale-Mw")).toBeNull();
      expect(ran).toEqual([]);
    });
  });

  it("wires the router's cache store into the request context", async () => {
    // Without the store, registerCachedFunction bypasses BEFORE the request-scope
    // (NOCACHE) check, so the brand would be inert. dispatch must surface the
    // configured store the way the production handler does.
    const store = new MemorySegmentCacheStore();
    const router = createRouter<{}>({ cache: { store } }).routes(
      urls(({ path }) => [
        path.json(
          "/api/probe",
          () => ({
            hasStore:
              (
                getRequestContext() as unknown as {
                  _cacheStore?: unknown;
                }
              )._cacheStore === store,
          }),
          { name: "api.probe" },
        ),
      ]),
    ) as Parameters<typeof dispatch>[0];

    const res = await dispatch(router, { request: "/api/probe" });
    expect((await res.json()).hasStore).toBe(true);
  });

  // I2: dispatch wires the production response-route cache path (resolved from
  // the matched entry tree), so a cached path.json/path.text route hits/writes
  // through dispatch the way it does in production — not a fresh run every call.
  describe("cached response routes (cache() boundary)", () => {
    // The cache WRITE is scheduled via ctx.waitUntil (a microtask without an
    // executionContext); flush the queue so the second dispatch can observe it.
    const flushWrites = () => new Promise((r) => setTimeout(r, 0));

    it("serves a cached path.json route from the store (same body on a HIT)", async () => {
      const store = new MemorySegmentCacheStore();
      const router = createRouter<{}>({ cache: { store } }).routes(
        urls(({ path, cache }) => [
          cache({ ttl: 600 }, () => [
            path.json("/cached", () => ({ ts: Date.now() + Math.random() }), {
              name: "cached.json",
            }),
          ]),
        ]),
      ) as Parameters<typeof dispatch>[0];

      const first = await (
        await dispatch(router, { request: "/cached" })
      ).json();
      await flushWrites();
      const second = await (
        await dispatch(router, { request: "/cached" })
      ).json();

      // A HIT returns the byte-identical cached body; a fresh re-run would carry
      // a new ts. (Before the fix dispatch never touched the store -> different.)
      expect(second).toEqual(first);
    });

    it("writes an entry into the store for a cached response route", async () => {
      const store = new MemorySegmentCacheStore();
      const router = createRouter<{}>({ cache: { store } }).routes(
        urls(({ path, cache }) => [
          cache({ ttl: 600 }, () => [
            path.json("/cached2", () => ({ ok: true }), {
              name: "cached2.json",
            }),
          ]),
        ]),
      ) as Parameters<typeof dispatch>[0];

      await dispatch(router, { request: "/cached2" });
      await flushWrites();

      // The production key shape: response:{type}:{host}{path}{search}.
      const cached = await store.getResponse("response:json:localhost/cached2");
      expect(cached).not.toBeNull();
      expect(cached?.response.status).toBe(200);
    });

    it("re-runs an UNcached response route every call (different body)", async () => {
      // Non-vacuity: without a cache() boundary the handler re-executes, so the
      // body changes — proving the equality above is caused by caching.
      const store = new MemorySegmentCacheStore();
      const router = createRouter<{}>({ cache: { store } }).routes(
        urls(({ path }) => [
          path.json("/uncached", () => ({ ts: Date.now() + Math.random() }), {
            name: "uncached.json",
          }),
        ]),
      ) as Parameters<typeof dispatch>[0];

      const first = await (
        await dispatch(router, { request: "/uncached" })
      ).json();
      await flushWrites();
      const second = await (
        await dispatch(router, { request: "/uncached" })
      ).json();
      expect(second).not.toEqual(first);
    });

    // P1 (security): when a CONFIGURED route-level cache({ key }) THROWS, the
    // response cache must DEGRADE TO A MISS — run the route uncached and write
    // NOTHING — never fall back to the broad default key. If the key encodes
    // tenant/user/auth state, caching personalized output under the broad key
    // would serve it cross-user (cache poisoning).
    it("degrades to an uncached miss when cache({ key }) throws (no store write)", async () => {
      const store = new MemorySegmentCacheStore();
      const putSpy = vi.spyOn(store, "putResponse");
      const router = createRouter<{}>({ cache: { store } }).routes(
        urls(({ path, cache }) => [
          cache(
            {
              ttl: 600,
              key: () => {
                throw new Error("key fn boom");
              },
            },
            () => [
              path.json(
                "/cached-keythrows",
                () => ({ ts: Date.now() + Math.random() }),
                { name: "cached.keythrows" },
              ),
            ],
          ),
        ]),
      ) as Parameters<typeof dispatch>[0];

      const first = await (
        await dispatch(router, { request: "/cached-keythrows" })
      ).json();
      await flushWrites();
      const second = await (
        await dispatch(router, { request: "/cached-keythrows" })
      ).json();

      // Served uncached: handler re-ran, so the body differs (no HIT under any key).
      expect(second).not.toEqual(first);
      // And nothing was written under ANY key (no broad-key poisoning).
      expect(putSpy).not.toHaveBeenCalled();
      putSpy.mockRestore();
    });

    it("still caches when cache({ key }) succeeds (HIT, store written)", async () => {
      const store = new MemorySegmentCacheStore();
      const putSpy = vi.spyOn(store, "putResponse");
      const router = createRouter<{}>({ cache: { store } }).routes(
        urls(({ path, cache }) => [
          cache({ ttl: 600, key: (ctx) => `tenant-a${ctx.pathname}` }, () => [
            path.json(
              "/cached-keyok",
              () => ({ ts: Date.now() + Math.random() }),
              { name: "cached.keyok" },
            ),
          ]),
        ]),
      ) as Parameters<typeof dispatch>[0];

      const first = await (
        await dispatch(router, { request: "/cached-keyok" })
      ).json();
      await flushWrites();
      const second = await (
        await dispatch(router, { request: "/cached-keyok" })
      ).json();

      // A HIT returns the byte-identical cached body, and the entry was written
      // under the custom key (response:tenant-a/cached-keyok).
      expect(second).toEqual(first);
      expect(putSpy).toHaveBeenCalled();
      expect(putSpy.mock.calls[0]?.[0]).toBe("response:tenant-a/cached-keyok");
      putSpy.mockRestore();
    });
  });

  it("throws a clear error for an RSC (component) route", async () => {
    const router = buildRouter();
    await expect(dispatch(router, { request: "/" })).rejects.toThrow(
      /does not render RSC routes/,
    );
  });

  it("runs global middleware and honors a redirect short-circuit", async () => {
    const redirectMw: MiddlewareFn = async () =>
      new Response(null, {
        status: 302,
        headers: { Location: "/login" },
      });

    const router = createRouter<{}>({})
      .use("/api/*", redirectMw)
      .routes(
        urls(({ path }) => [
          path.json("/api/data", () => ({ hello: "world" }), {
            name: "api.data",
          }),
        ]),
      ) as any;

    const res = await dispatch(router, { request: "/api/data" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });

  // The server-side open-redirect guard (rsc/redirect-guard.ts) is applied at
  // dispatch's final return, mirroring production's single handler chokepoint,
  // so a consumer can unit-test the same-origin contract for browser-followed
  // (document-native) redirects through the public primitive.
  describe("open-redirect guard (document-native)", () => {
    function routerWithMw(mw: MiddlewareFn) {
      return createRouter<{}>({})
        .use("/api/*", mw)
        .routes(
          urls(({ path }) => [
            path.json("/api/data", () => ({ ok: true }), { name: "api.data" }),
          ]),
        ) as any;
    }

    it("blocks a cross-origin middleware redirect, rewriting Location to root", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const mw: MiddlewareFn = () => redirect("https://evil.com/phish");
      const res = await dispatch(routerWithMw(mw), {
        request: "http://localhost/api/data",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/");
      spy.mockRestore();
    });

    it("blocks a protocol-relative cross-origin redirect", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const mw: MiddlewareFn = () => redirect("//evil.com/phish");
      const res = await dispatch(routerWithMw(mw), {
        request: "http://localhost/api/data",
      });
      expect(res.headers.get("Location")).toBe("/");
      spy.mockRestore();
    });

    it("allows a cross-origin redirect opted in with { external: true } and strips the marker", async () => {
      const mw: MiddlewareFn = () =>
        redirect("https://accounts.example.com/oauth", { external: true });
      const res = await dispatch(routerWithMw(mw), {
        request: "http://localhost/api/data",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(
        "https://accounts.example.com/oauth",
      );
      // Internal opt-in marker never reaches the browser.
      expect(res.headers.get("x-rango-redirect-external")).toBeNull();
    });

    it("passes a same-origin middleware redirect through unchanged", async () => {
      const mw: MiddlewareFn = () => redirect("/login");
      const res = await dispatch(routerWithMw(mw), {
        request: "http://localhost/api/data",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/login");
    });

    it("blocks a cross-origin redirect returned from a response-route handler", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const router = createRouter<{}>({}).routes(
        urls(({ path }) => [
          path.json("/go", () => redirect("https://evil.com/phish"), {
            name: "go",
          }),
        ]),
      ) as any;
      const res = await dispatch(router, { request: "http://localhost/go" });
      expect(res.headers.get("Location")).toBe("/");
      spy.mockRestore();
    });

    it("allows an external redirect returned from a response-route handler (brand survives rewrap)", async () => {
      const router = createRouter<{}>({}).routes(
        urls(({ path }) => [
          path.json(
            "/go",
            () =>
              redirect("https://accounts.example.com/oauth", {
                external: true,
              }),
            { name: "go" },
          ),
        ]),
      ) as any;
      const res = await dispatch(router, { request: "http://localhost/go" });
      expect(res.headers.get("Location")).toBe(
        "https://accounts.example.com/oauth",
      );
      expect(res.headers.get("x-rango-redirect-external")).toBeNull();
    });

    // Finding #1 regression (forgeable opt-in): the external opt-in is an
    // out-of-band brand on the Response object, NOT the wire header. A
    // proxy-style response route that returns an attacker-controlled upstream
    // response carrying a forged `x-rango-redirect-external` header must NOT be
    // able to bypass the same-origin guard -- the app never called
    // redirect(..., { external: true }), so the off-host target is neutralized.
    it("does NOT honor a forged external marker header from a response-route handler", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const router = createRouter<{}>({}).routes(
        urls(({ path }) => [
          path.json(
            "/proxy",
            () =>
              // Simulates returning a proxied upstream 302 whose headers an
              // attacker controls. The forged marker is the ONLY external signal
              // (no redirect(..., { external: true }) brand).
              new Response(null, {
                status: 302,
                headers: {
                  Location: "https://evil.example/phish",
                  "x-rango-redirect-external": "1",
                },
              }),
            { name: "proxy" },
          ),
        ]),
      ) as any;
      const res = await dispatch(router, { request: "http://localhost/proxy" });
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/");
      // The forged header never reaches the browser.
      expect(res.headers.get("x-rango-redirect-external")).toBeNull();
      spy.mockRestore();
    });

    // Brand-drop regression: an onResponse callback that returns a NEW Response
    // drops the object-identity brand. finalizeResponse must re-mark it so a
    // legit redirect(url, { external: true }) is still allowed off-host (not
    // silently neutralized to root) when the app also uses ctx.onResponse().
    it("preserves { external: true } when an onResponse callback rebuilds the Response", async () => {
      const mw: MiddlewareFn = () => {
        const ctx = getRequestContext();
        // Rebuild the Response (e.g. to add a header). The new object loses the
        // brand unless drainOnResponseCallbacks re-applies it.
        ctx.onResponse(
          (res) =>
            new Response(res.body, {
              status: res.status,
              headers: new Headers(res.headers),
            }),
        );
        return redirect("https://accounts.example.com/oauth", {
          external: true,
        });
      };
      const res = await dispatch(routerWithMw(mw), {
        request: "http://localhost/api/data",
      });
      expect(res.headers.get("Location")).toBe(
        "https://accounts.example.com/oauth",
      );
      expect(res.headers.get("x-rango-redirect-external")).toBeNull();
    });

    // Header-leak regression (defense-in-depth): the reserved marker must never
    // reach the browser, even on a non-3xx response the 3xx-only guard does not
    // touch. mergeResponse strips it from the base response on the middleware path.
    it("strips a forged external marker header from a non-3xx middleware response", async () => {
      const mw: MiddlewareFn = () =>
        new Response("ok", {
          status: 200,
          headers: {
            "x-rango-redirect-external": "1",
            "content-type": "text/plain",
          },
        });
      const res = await dispatch(routerWithMw(mw), {
        request: "http://localhost/api/data",
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-rango-redirect-external")).toBeNull();
    });

    // Header-leak via the STUB (ctx.header), not the base response. Stripping the
    // base in mergeResponse is not enough -- the stub-merge primitives re-add it.
    // mergeStubHeaders must refuse to copy the reserved marker.
    it("strips a reserved marker set via ctx.header() on a non-3xx middleware short-circuit", async () => {
      const mw: MiddlewareFn = (ctx) => {
        ctx.header("x-rango-redirect-external", "1");
        return new Response("ok", { status: 200 });
      };
      const res = await dispatch(routerWithMw(mw), {
        request: "http://localhost/api/data",
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-rango-redirect-external")).toBeNull();
    });

    // Same leak via a response route's ctx.header() on a 200: the serialized
    // result flows through createResponseWithMergedHeaders -> applyStubHeaders,
    // which must refuse to copy the reserved marker.
    it("strips a reserved marker set via ctx.header() on a response-route 200", async () => {
      const router = createRouter<{}>({}).routes(
        urls(({ path }) => [
          path.json(
            "/h",
            () => {
              getRequestContext().header("x-rango-redirect-external", "1");
              return { ok: true };
            },
            { name: "h" },
          ),
        ]),
      ) as any;
      const res = await dispatch(router, { request: "http://localhost/h" });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-rango-redirect-external")).toBeNull();
      expect(await res.json()).toEqual({ ok: true });
    });

    // Same leak via the request-context stub merged through the middleware chain
    // (mergeReqCtxStub) on a 200 downstream response.
    it("strips a reserved marker set on the request-context stub through the middleware chain", async () => {
      const mw: MiddlewareFn = (_ctx, next) => {
        getRequestContext().header("x-rango-redirect-external", "1");
        return next();
      };
      const router = createRouter<{}>({})
        .use(mw)
        .routes(
          urls(({ path }) => [
            path.json("/api/data", () => ({ ok: true }), { name: "api.data" }),
          ]),
        ) as any;
      const res = await dispatch(router, {
        request: "http://localhost/api/data",
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-rango-redirect-external")).toBeNull();
    });
  });

  it("lets global middleware pass through to the response route", async () => {
    let ran = false;
    const tagMw: MiddlewareFn = async (ctx, next) => {
      ran = true;
      ctx.header("X-Tag", "yes");
      return next();
    };

    const router = createRouter<{}>({})
      .use(tagMw)
      .routes(
        urls(({ path }) => [
          path.json("/api/data", () => ({ ok: true }), { name: "api.data" }),
        ]),
      ) as any;

    const res = await dispatch(router, { request: "/api/data" });
    expect(ran).toBe(true);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Tag")).toBe("yes");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("surfaces cookies set inside a response-route handler", async () => {
    const router = createRouter<{}>({}).routes(
      urls(({ path }) => [
        path.json(
          "/api/login",
          () => {
            cookies().set("session", "tok", { path: "/" });
            return { ok: true };
          },
          { name: "api.login" },
        ),
      ]),
    ) as any;

    const res = await dispatch(router, { request: "/api/login" });
    const setCookie = res.headers.getSetCookie();
    expect(setCookie.some((c) => c.startsWith("session=tok"))).toBe(true);
  });

  // A handler that returns a Response goes through the same rewrapResponse path
  // as handleResponseRoute: stub headers/cookies merge, multiple Set-Cookie are
  // preserved, the ctx.setStatus override wins, statusText is dropped, and a
  // WebSocket-upgrade response is passed through WITHOUT reconstruction.
  describe("handler-returned Response mirrors production rewrap", () => {
    it("preserves multiple Set-Cookie headers (and drops statusText) on a returned Response", async () => {
      // Combines the Set-Cookie preservation with a custom statusText so this is
      // ALSO a regression guard for the statusText drop: pre-fix the generic
      // re-wrap carried statusText through, post-fix rewrapHandlerResponse mirrors
      // production and drops it.
      const router = createRouter<{}>({}).routes(
        urls(({ path }) => [
          path.json(
            "/api/multi",
            () => {
              const res = new Response(JSON.stringify({ ok: true }), {
                status: 200,
                statusText: "Custom",
                headers: { "content-type": "application/json" },
              });
              res.headers.append("set-cookie", "a=1; Path=/");
              res.headers.append("set-cookie", "b=2; Path=/");
              return res;
            },
            { name: "api.multi" },
          ),
        ]),
      ) as any;

      const res = await dispatch(router, { request: "/api/multi" });
      expect(res.status).toBe(200);
      expect(res.statusText).toBe("");
      const cookies = res.headers.getSetCookie();
      expect(cookies).toContain("a=1; Path=/");
      expect(cookies).toContain("b=2; Path=/");
      expect(await res.json()).toEqual({ ok: true });
    });

    it("drops statusText across the re-wrap (production parity)", async () => {
      const router = createRouter<{}>({}).routes(
        urls(({ path }) => [
          path.json(
            "/api/oddstatus",
            () =>
              new Response("brewing", {
                status: 299,
                statusText: "Weird Status",
              }),
            { name: "api.oddstatus" },
          ),
        ]),
      ) as any;

      const res = await dispatch(router, { request: "/api/oddstatus" });
      expect(res.status).toBe(299);
      // handleResponseRoute rebuilds the Response without carrying statusText.
      expect(res.statusText).toBe("");
      expect(await res.text()).toBe("brewing");
    });

    it("lets ctx.setStatus() override the returned Response's status", async () => {
      const router = createRouter<{}>({}).routes(
        urls(({ path }) => [
          path.json(
            "/api/override",
            () => {
              getRequestContext().setStatus(202);
              return new Response("queued", { status: 201 });
            },
            { name: "api.override" },
          ),
        ]),
      ) as any;

      const res = await dispatch(router, { request: "/api/override" });
      expect(res.status).toBe(202);
      expect(await res.text()).toBe("queued");
    });

    it("merges ctx.header() stub headers onto a returned Response", async () => {
      const router = createRouter<{}>({}).routes(
        urls(({ path }) => [
          path.json(
            "/api/stub",
            (ctx: { header: (n: string, v: string) => void }) => {
              ctx.header("X-Tag", "yes");
              const res = new Response("ok", { status: 200 });
              res.headers.set("X-Handler", "set");
              return res;
            },
            { name: "api.stub" },
          ),
        ]),
      ) as any;

      const res = await dispatch(router, { request: "/api/stub" });
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Tag")).toBe("yes");
      expect(res.headers.get("X-Handler")).toBe("set");
    });

    it("passes a WebSocket-upgrade Response through without reconstruction", async () => {
      // A WebSocket upgrade response carries a `webSocket` property (Cloudflare)
      // and/or status 101 — which the Response constructor rejects. Production
      // bypasses reconstruction via mergeStubHeadersAndFinalize; dispatch must
      // too, or reconstruction would throw (101) / drop the socket. status 101
      // cannot be built with `new Response` in a unit test, so this exercises the
      // `webSocket`-property branch of isWebSocketUpgradeResponse — the SAME
      // object must be returned (not rebuilt), so the property survives.
      const socket = { kind: "fake-socket" };
      const router = createRouter<{}>({}).routes(
        urls(({ path }) => [
          path.json(
            "/api/ws",
            () => {
              const res = new Response(null, { status: 200 });
              (res as unknown as { webSocket?: unknown }).webSocket = socket;
              return res;
            },
            { name: "api.ws" },
          ),
        ]),
      ) as any;

      const res = await dispatch(router, { request: "/api/ws" });
      expect((res as unknown as { webSocket?: unknown }).webSocket).toBe(
        socket,
      );
    });
  });

  // Handler-error mapping mirrors handleResponseRoute's catch block:
  // status is RouterError.status (else 500), json routes return an RFC 9457
  // problem+json body (application/problem+json), other types return a
  // text/plain message, and the dev/prod branch governs how much of a
  // non-RouterError surfaces.
  describe("handler errors mirror production response-route mapping", () => {
    it("maps a thrown generic Error on a json route to a problem+json 500 (dev exposes message)", async () => {
      const router = createRouter<{}>({}).routes(
        urls(({ path }) => [
          path.json(
            "/api/boom",
            () => {
              throw new Error("kaboom");
            },
            { name: "api.boom" },
          ),
        ]),
      ) as any;

      const res = await dispatch(router, { request: "/api/boom" });
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toBe(
        "application/problem+json;charset=utf-8",
      );
      // NODE_ENV is "test" under vitest, so the dev branch exposes the message.
      const body = await res.json();
      expect(body.detail).toBe("kaboom");
      // Non-RouterError failures always carry the generic INTERNAL code and the
      // status reason phrase as the problem title.
      expect(body.code).toBe("INTERNAL");
      expect(body.title).toBe("Internal Server Error");
      expect(body.status).toBe(500);
      // `type` is omitted this phase (RFC 9457 absent type === "about:blank").
      expect(body.type).toBeUndefined();
    });

    // Parity regression (#572 / #582): a json route that returns a nested
    // unresolved Promise (forgotten await) must reject EXACTLY like production.
    // Pre-fix, dispatch did a bare JSON.stringify and shipped `{"data":{}}` green
    // while production throws RESPONSE_NOT_SERIALIZABLE and 500s. The shared
    // stringifyJsonRouteResult guard makes dispatch fail where production fails.
    it("rejects a json route returning a nested Promise (forgotten await) as a problem+json 500, like production", async () => {
      const router = createRouter<{}>({}).routes(
        urls(({ path }) => [
          path.json(
            "/api/forgot-await",
            // The cast mimics an `as`-cast or untyped (JS) handler slipping a
            // Promise past the compile-time nested-Promise rejection.
            (() => ({ data: Promise.resolve("late") })) as any,
            { name: "api.forgotAwait" },
          ),
        ]),
      ) as any;

      const res = await dispatch(router, { request: "/api/forgot-await" });
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toBe(
        "application/problem+json;charset=utf-8",
      );
      const body = await res.json();
      expect(body.code).toBe("RESPONSE_NOT_SERIALIZABLE");
      expect(body.status).toBe(500);
      // The silent forgotten-await body must NEVER ship.
      expect(body).not.toHaveProperty("data");
    });

    it("sanitizes a thrown generic Error on a json route to a problem+json 500 in production", async () => {
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      try {
        const router = createRouter<{}>({}).routes(
          urls(({ path }) => [
            path.json(
              "/api/boom",
              () => {
                throw new Error("secret internal detail");
              },
              { name: "api.boom" },
            ),
          ]),
        ) as any;

        const res = await dispatch(router, { request: "/api/boom" });
        expect(res.status).toBe(500);
        expect(res.headers.get("content-type")).toBe(
          "application/problem+json;charset=utf-8",
        );
        const body = await res.json();
        expect(body.detail).toBe("Internal Server Error");
        expect(body.code).toBe("INTERNAL");
        expect(body.stack).toBeUndefined();
      } finally {
        process.env.NODE_ENV = prev;
      }
    });

    it("maps a thrown RouterError to its status with code/detail exposed", async () => {
      const router = createRouter<{}>({}).routes(
        urls(({ path }) => [
          path.json(
            "/api/missing",
            () => {
              throw new RouterError("NOT_FOUND", "Item not found", {
                status: 404,
              });
            },
            { name: "api.missing" },
          ),
        ]),
      ) as any;

      const res = await dispatch(router, { request: "/api/missing" });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe(
        "application/problem+json;charset=utf-8",
      );
      const body = await res.json();
      expect(body.detail).toBe("Item not found");
      expect(body.code).toBe("NOT_FOUND");
      expect(body.title).toBe("Not Found");
      expect(body.status).toBe(404);
      // `type` is omitted this phase (RouterError no longer carries one).
      expect(body.type).toBeUndefined();
    });

    it("resolves the effective ctx.setStatus() status into the problem body (production parity)", async () => {
      // Production resolves the effective status (ctx.res.status override) BEFORE
      // building the problem body, so a handler that setStatus(400) then throws a
      // plain Error yields a body whose status/title say 400 — not the derived
      // 500. dispatch mirrors handleResponseRoute's catch resolution.
      const router = createRouter<{}>({}).routes(
        urls(({ path }) => [
          path.json(
            "/api/bad",
            () => {
              getRequestContext().setStatus(400);
              throw new Error("bad input");
            },
            { name: "api.bad" },
          ),
        ]),
      ) as any;

      const res = await dispatch(router, { request: "/api/bad" });
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toBe(
        "application/problem+json;charset=utf-8",
      );
      const body = await res.json();
      expect(body.status).toBe(400);
      expect(body.title).toBe("Bad Request");
      expect(body.code).toBe("INTERNAL");
      expect(body.detail).toBe("bad input");
    });

    it("maps a thrown error on a text route to a text/plain 500 (dev message)", async () => {
      const router = createRouter<{}>({}).routes(
        urls(({ path }) => [
          path.text(
            "/api/explode",
            () => {
              throw new Error("text boom");
            },
            { name: "api.explode" },
          ),
        ]),
      ) as any;

      const res = await dispatch(router, { request: "/api/explode" });
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toBe("text/plain;charset=utf-8");
      expect(await res.text()).toBe("text boom");
    });

    it("returns a generic text/plain 500 for a thrown error on a text route in production", async () => {
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      try {
        const router = createRouter<{}>({}).routes(
          urls(({ path }) => [
            path.text(
              "/api/explode",
              () => {
                throw new Error("hidden detail");
              },
              { name: "api.explode" },
            ),
          ]),
        ) as any;

        const res = await dispatch(router, { request: "/api/explode" });
        expect(res.status).toBe(500);
        expect(res.headers.get("content-type")).toBe(
          "text/plain;charset=utf-8",
        );
        expect(await res.text()).toBe("Internal Server Error");
      } finally {
        process.env.NODE_ENV = prev;
      }
    });
  });

  // Content negotiation: when the router's previewMatch reports negotiated:true
  // (set only when a route has negotiate variants and a response-route variant
  // wins), dispatch appends Vary: Accept, matching handleResponseRoute's
  // callHandlerWithVary. Plain (single-variant) response routes report no
  // negotiated flag and get no Vary.
  //
  // negotiated:true is populated from the build-time route trie, which the
  // in-memory createRouter() test path does not construct (it uses the regex
  // fallback). The real trie-driven Vary integration is e2e-covered in
  // e2e/content-negotiation.test.ts (dev + production). These tests pin
  // dispatch's own contract via a minimal router whose previewMatch returns
  // the negotiated flag, so the dispatch-side behavior is exercised directly.
  describe("Vary: Accept on negotiated response routes", () => {
    function negotiatedStubRouter(opts: {
      negotiated: boolean;
      responseType?: string;
      handler?: (ctx: any) => unknown;
    }) {
      const responseType = opts.responseType ?? "json";
      const handler = opts.handler ?? (() => ({ shape: responseType }));
      return {
        id: "stub-negotiate",
        routeMap: { stub: "/data" },
        middleware: [],
        findMatch: (_pathname: string) => ({
          routeKey: "stub",
          params: {},
        }),
        previewMatch: async () => ({
          responseType,
          handler,
          params: {},
          routeKey: "stub",
          ...(opts.negotiated ? { negotiated: true } : {}),
        }),
      } as any;
    }

    it("appends Vary: Accept when previewMatch reports a negotiated variant", async () => {
      const router = negotiatedStubRouter({ negotiated: true });
      const res = await dispatch(router, {
        request: new Request("http://localhost/data", {
          headers: { accept: "application/json" },
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(
        "application/json;charset=utf-8",
      );
      expect(res.headers.get("Vary")).toBe("Accept");
      expect(await res.json()).toEqual({ shape: "json" });
    });

    it("appends Vary: Accept on a negotiated text variant", async () => {
      const router = negotiatedStubRouter({
        negotiated: true,
        responseType: "text",
        handler: () => "shape=text",
      });
      const res = await dispatch(router, {
        request: new Request("http://localhost/data", {
          headers: { accept: "text/plain" },
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/plain;charset=utf-8");
      expect(res.headers.get("Vary")).toBe("Accept");
      expect(await res.text()).toBe("shape=text");
    });

    it("omits Vary on a non-negotiated response route", async () => {
      const router = negotiatedStubRouter({ negotiated: false });
      const res = await dispatch(router, { request: "/data" });

      expect(res.status).toBe(200);
      expect(res.headers.get("Vary")).toBeNull();
      expect(await res.json()).toEqual({ shape: "json" });
    });
  });

  // Production wraps EVERYTHING (the trailing-slash 308, the unmatched 404, the
  // response route) in the global middleware chain and finalizes terminally
  // (handler.ts:481-502). These tests pin dispatch to that ordering: global
  // middleware runs first (so it can short-circuit the 308/404), its
  // cookies/headers merge onto the 308, partial redirects are made Flight-safe,
  // and onResponse callbacks drain on every exit. Each fails on the pre-fix code.
  describe("global chain wraps the 308/404 and finalizes terminally (production parity)", () => {
    it("lets global middleware 401 WIN over the trailing-slash 308", async () => {
      // Pre-fix dispatch returned the 308 before any middleware ran. Production
      // produces the 308 inside coreHandler, wrapped by the global chain, so an
      // auth middleware short-circuits it.
      let ran = false;
      const authMw: MiddlewareFn = async () => {
        ran = true;
        return new Response(null, { status: 401 });
      };
      const router = createRouter<{}>({})
        .use(authMw)
        .routes(
          urls(({ path }) => [
            path("/old/", Home, { name: "old", trailingSlash: "always" }),
          ]),
        ) as any;

      const res = await dispatch(router, { request: "/old" });
      expect(ran).toBe(true);
      expect(res.status).toBe(401);
      expect(res.headers.get("Location")).toBeNull();
    });

    it("lets global middleware 401 WIN over the unmatched 404", async () => {
      // Production throws RouteNotFoundError inside coreHandler (wrapped by the
      // chain), so middleware runs before the 404 is produced.
      let ran = false;
      const authMw: MiddlewareFn = async () => {
        ran = true;
        return new Response(null, { status: 401 });
      };
      const router = createRouter<{}>({})
        .use(authMw)
        .routes(
          urls(({ path }) => [
            path.json("/api/data", () => ({ ok: true }), { name: "api.data" }),
          ]),
        ) as any;

      const res = await dispatch(router, { request: "/nope" });
      expect(ran).toBe(true);
      expect(res.status).toBe(401);
    });

    it("merges middleware cookies/headers onto the 308 when middleware calls next()", async () => {
      // Production builds the 308 via createResponseWithMergedHeaders inside
      // coreHandler, so a passing-through middleware's stub cookies/headers
      // merge onto it. Pre-fix dispatch returned a bare 308 before middleware.
      const tagMw: MiddlewareFn = async (ctx, next) => {
        ctx.header("X-Tag", "yes");
        cookies().set("session", "tok", { path: "/" });
        return next();
      };
      const router = createRouter<{}>({})
        .use(tagMw)
        .routes(
          urls(({ path }) => [
            path("/old/", Home, { name: "old", trailingSlash: "always" }),
          ]),
        ) as any;

      const res = await dispatch(router, { request: "/old?ref=email" });
      expect(res.status).toBe(308);
      expect(res.headers.get("Location")).toBe("/old/?ref=email");
      expect(res.headers.get("X-Tag")).toBe("yes");
      expect(
        res.headers.getSetCookie().some((c) => c.startsWith("session=tok")),
      ).toBe(true);
    });

    it("converts a middleware 302 on a _rsc_partial request to 204 + X-RSC-Redirect", async () => {
      // Production's global-chain exit runs interceptRedirectForPartial on a
      // partial/action request (handler.ts:491-499): a no-location-state 3xx
      // becomes a 204 + X-RSC-Redirect so fetch() does not auto-follow it.
      // Pre-fix dispatch returned the raw 302.
      const redirectMw: MiddlewareFn = async () =>
        new Response(null, { status: 302, headers: { Location: "/login" } });
      const router = createRouter<{}>({})
        .use(redirectMw)
        .routes(
          urls(({ path }) => [
            path.json("/api/data", () => ({ ok: true }), { name: "api.data" }),
          ]),
        ) as any;

      const res = await dispatch(router, {
        request: "/api/data?_rsc_partial=1",
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("X-RSC-Redirect")).toBe("/login");
      // The raw 3xx Location is replaced by the Flight-safe header.
      expect(res.headers.get("Location")).toBeNull();
    });

    it("converts a middleware 302 on a _rsc_action request to 204 + X-RSC-Redirect", async () => {
      // interceptRedirectForPartial runs on partial AND action requests alike, so
      // a middleware redirect on an action request (?_rsc_action=1) must also
      // become a 204 + X-RSC-Redirect (dispatch does not execute the action
      // itself, but the global middleware chain still runs and can redirect).
      const redirectMw: MiddlewareFn = async () =>
        new Response(null, { status: 302, headers: { Location: "/login" } });
      const router = createRouter<{}>({})
        .use(redirectMw)
        .routes(
          urls(({ path }) => [
            path.json("/api/data", () => ({ ok: true }), { name: "api.data" }),
          ]),
        ) as any;

      const res = await dispatch(router, {
        request: "/api/data?_rsc_action=1",
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("X-RSC-Redirect")).toBe("/login");
      expect(res.headers.get("Location")).toBeNull();
    });

    it("fires ctx.onResponse() when global middleware short-circuits", async () => {
      // Production drains onResponse via finalizeResponse on every global-chain
      // exit (handler.ts:499-501). A middleware that registers an onResponse
      // hook and then short-circuits had its callback silently dropped pre-fix
      // (the drain only ran inside createResponseWithMergedHeaders on handler
      // paths, which a short-circuit never reaches).
      const gateMw: MiddlewareFn = async () => {
        const ctx = getRequestContext();
        ctx.onResponse((res) => {
          res.headers.set("x-on-response", "ran");
          return res;
        });
        return new Response(null, { status: 403 });
      };
      const router = createRouter<{}>({})
        .use(gateMw)
        .routes(
          urls(({ path }) => [
            path.json("/api/data", () => ({ ok: true }), { name: "api.data" }),
          ]),
        ) as any;

      const res = await dispatch(router, { request: "/api/data" });
      expect(res.status).toBe(403);
      expect(res.headers.get("x-on-response")).toBe("ran");
    });
  });

  describe("a router built with a document (T3)", () => {
    it("constructs and dispatches with a server-component document (no 'use client' throw under the test runner)", async () => {
      // Almost every real app sets `document`. In a bare test the "use client"
      // transform has not run, so the document has no client marker — pre-T3
      // this threw at createRouter and blocked importing the real router for
      // dispatch/assertGeneratedRoutesMatch. It must now construct (dispatch
      // never renders the document).
      function AppDocument() {
        return null;
      }
      const router = createRouter({ document: AppDocument }).routes(
        urls(({ path }) => [
          path.json("/api/data", () => ({ hello: "world" }), {
            name: "api.data",
          }),
        ]),
      ) as any;

      const res = await dispatch(router, { request: "/api/data" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ hello: "world" });
    });
  });
});
