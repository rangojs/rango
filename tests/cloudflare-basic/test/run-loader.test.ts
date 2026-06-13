import { describe, expect, it } from "vitest";
import { runLoader } from "@rangojs/router/testing";
import {
  cookieOverlayLoaderBody,
  CookieOverlayLoader,
} from "../src/loaders/cookie-overlay.js";
import {
  livePricesLoaderBody,
  RenderedProducts,
} from "../src/pages/rendered-barrier.js";

describe("runLoader against cloudflare-basic loader bodies", () => {
  // The REAL app loader body: it reads the request cookie jar via cookies().
  // runLoader runs it inside a real RequestContext, so cookies() resolves
  // against the Request we pass — exercising real cookie parsing, not a mock.
  describe("cookieOverlayLoaderBody (reads cookies())", () => {
    it("surfaces cookies present on the request", async () => {
      const data = await runLoader(cookieOverlayLoaderBody, {
        request: new Request("http://localhost/cookie-overlay", {
          headers: {
            cookie: "mw-overlay=from-middleware; action-overlay=from-action",
          },
        }),
      });
      expect(data.mwCookie).toBe("from-middleware");
      expect(data.actionCookie).toBe("from-action");
      expect(data.deletedCookie).toBeNull();
    });

    it("returns nulls when no cookies are present", async () => {
      const data = await runLoader(cookieOverlayLoaderBody, {});
      expect(data).toEqual({
        mwCookie: null,
        actionCookie: null,
        deletedCookie: null,
      });
    });
  });

  // #7: runLoader now accepts the registered createLoader() HANDLE directly, not
  // only the extracted body. createLoader assigns a runtime-fallback $$id and
  // registers its fn even without the Vite plugin (when imported through the
  // server build, which @rangojs/router under rangoTestConfig resolves to), so
  // runLoader recovers the fn from the registry. This removes the
  // body-extraction tax: an app no longer has to export the body separately for
  // testability.
  describe("the registered createLoader() handle (no body extraction needed)", () => {
    it("runs CookieOverlayLoader (the handle) and resolves request cookies", async () => {
      const data = await runLoader(CookieOverlayLoader, {
        request: new Request("http://localhost/cookie-overlay", {
          headers: {
            cookie: "mw-overlay=from-middleware; action-overlay=from-action",
          },
        }),
      });
      expect(data.mwCookie).toBe("from-middleware");
      expect(data.actionCookie).toBe("from-action");
    });

    it("the handle and the extracted body produce identical results", async () => {
      const makeReq = () =>
        new Request("http://localhost/cookie-overlay", {
          headers: { cookie: "mw-overlay=x; action-overlay=y" },
        });
      const viaHandle = await runLoader(CookieOverlayLoader, {
        request: makeReq(),
      });
      const viaBody = await runLoader(cookieOverlayLoaderBody, {
        request: makeReq(),
      });
      expect(viaHandle).toEqual(viaBody);
    });
  });

  // Infra-surface coverage: cloudflare-basic's own loaders are intentionally
  // thin (no params/reverse/env in their bodies), so this representative body
  // pins the runLoader option surface a richer consumer loader would rely on:
  // params, env bindings, prior-middleware vars, search, and ctx.reverse via a
  // routeMap. The richer real-loader dogfood lives in the mini / e2e-basic apps.
  //
  // Note: in a runLoader body, ctx.reverse accepts any routeMap name and ctx.get
  // accepts any string key/ContextVar (TestLoaderContext relaxes both, since the
  // names/keys come from the routeMap/vars options) — no casts needed. The `vars`
  // object form below also infers cleanly. Both were fixed during this dogfood.
  describe("loader context surface (params / env / vars / reverse / search)", () => {
    it("exposes params, env, a prior var, search, and a working reverse()", async () => {
      const data = await runLoader(
        async (ctx) => ({
          id: ctx.params.id,
          tier: (ctx.env as { tier: string }).tier,
          ad: ctx.get<string>("adHocVar"),
          q: ctx.searchParams.get("q"),
          self: ctx.reverse("product", { id: ctx.params.id }),
        }),
        {
          params: { id: "42" },
          env: { tier: "pro" },
          vars: { adHocVar: "seeded" },
          search: { q: "widgets" },
          routeMap: { product: "/products/:id" },
        },
      );
      expect(data).toEqual({
        id: "42",
        tier: "pro",
        ad: "seeded",
        q: "widgets",
        self: "/products/42",
      });
    });

    it("throws a clear error if ctx.reverse() is used without a routeMap", async () => {
      await expect(
        runLoader(async (ctx) => ctx.reverse("product", { id: "1" }), {
          params: { id: "1" },
        }),
      ).rejects.toThrow();
    });
  });

  // The REAL rendered-barrier loader: it awaits ctx.rendered() then reads handle
  // data via ctx.use(RenderedProducts). Mock the barrier + seed the handle to
  // unit-test the post-barrier price-mapping logic (the real push/accumulate/
  // barrier wiring stays e2e — rendered-barrier.test.ts).
  describe("livePricesLoaderBody (awaits ctx.rendered(), reads a handle)", () => {
    it("maps seeded product ids to prices after the (mocked) barrier", async () => {
      const data = await runLoader(livePricesLoaderBody, {
        rendered: true,
        handles: [[RenderedProducts, ["widget-a", "widget-b", "widget-c"]]],
      });
      expect(data.prices).toEqual({
        "widget-a": 9.99,
        "widget-b": 19.99,
        "widget-c": 29.99,
      });
      expect(typeof data.fetchedAt).toBe("number");
    });

    it("defaults unknown product ids to 0", async () => {
      const data = await runLoader(livePricesLoaderBody, {
        rendered: true,
        handles: [[RenderedProducts, ["widget-a", "mystery"]]],
      });
      expect(data.prices).toEqual({ "widget-a": 9.99, mystery: 0 });
    });

    it("still throws if ctx.rendered() is used without opting in", async () => {
      await expect(
        runLoader(livePricesLoaderBody, {
          handles: [[RenderedProducts, ["widget-a"]]],
        }),
      ).rejects.toThrow(/ctx\.rendered\(\) is not available/);
    });
  });
});
