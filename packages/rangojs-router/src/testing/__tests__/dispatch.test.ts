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
  it("serializes a JSON response route (auto-wrapped under data)", async () => {
    const router = buildRouter();
    const res = await dispatch(router, { request: "/api/data" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/json;charset=utf-8",
    );
    expect(await res.json()).toEqual({ data: { hello: "world" } });
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
    expect(await res.json()).toEqual({ data: { ok: true } });
  });

  it("passes route params to a response-route handler", async () => {
    const router = buildRouter();
    const res = await dispatch(router, { request: "/api/echo/42" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: "42" } });
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
    const body = (await res.json()) as {
      data: { reversed?: string; error?: string };
    };
    // Pin the exact production behavior: with no explicit params the :id segment
    // is left unsubstituted (the raw pattern), NOT auto-filled from the request.
    expect(body.data.reversed).toBe("/api/self/:id");
    expect(body.data.error).toBeUndefined();
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
    expect((await res.json()).data.hasStore).toBe(true);
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
    expect(await res.json()).toEqual({ data: { ok: true } });
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

  // Handler-error mapping mirrors handleResponseRoute's catch block:
  // status is RouterError.status (else 500), json routes return a typed
  // { error } envelope, other types return a text/plain message, and the
  // dev/prod branch governs how much of a non-RouterError surfaces.
  describe("handler errors mirror production response-route mapping", () => {
    it("maps a thrown generic Error on a json route to a typed 500 (dev exposes message)", async () => {
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
        "application/json;charset=utf-8",
      );
      // NODE_ENV is "test" under vitest, so the dev branch exposes the message.
      const body = await res.json();
      expect(body.error.message).toBe("kaboom");
    });

    it("sanitizes a thrown generic Error on a json route to a 500 envelope in production", async () => {
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
          "application/json;charset=utf-8",
        );
        const body = await res.json();
        expect(body.error.message).toBe("Internal Server Error");
        expect(body.error.stack).toBeUndefined();
      } finally {
        process.env.NODE_ENV = prev;
      }
    });

    it("maps a thrown RouterError to its status with code/type exposed", async () => {
      const router = createRouter<{}>({}).routes(
        urls(({ path }) => [
          path.json(
            "/api/missing",
            () => {
              throw new RouterError("NOT_FOUND", "Item not found", {
                status: 404,
                type: "https://errors/not-found",
              });
            },
            { name: "api.missing" },
          ),
        ]),
      ) as any;

      const res = await dispatch(router, { request: "/api/missing" });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe(
        "application/json;charset=utf-8",
      );
      const body = await res.json();
      expect(body.error.message).toBe("Item not found");
      expect(body.error.code).toBe("NOT_FOUND");
      expect(body.error.type).toBe("https://errors/not-found");
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
      expect(await res.json()).toEqual({ data: { shape: "json" } });
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
      expect(await res.json()).toEqual({ data: { shape: "json" } });
    });
  });
});
