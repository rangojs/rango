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
});
