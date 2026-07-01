import { describe, it, expect, vi } from "vitest";

// createRouter's match path transitively imports @vitejs/plugin-rsc/rsc, whose
// top-level body imports Vite virtual modules that do not resolve in plain
// node/vitest. dispatch() never renders RSC, so a stub is sufficient. (Same
// stub as dispatch.test.ts.)
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
import {
  diffGeneratedRoutes,
  assertGeneratedRoutesMatch,
} from "../generated-routes.js";
import { createRouter } from "../../router.js";
import { urls } from "../../urls/urls-function.js";

// Public-path coverage for async `include(prefix, () => import("./routes"))`,
// exercised through the real createRouter() wiring + dispatch() (not the
// extracted evaluateLazyEntry helper). This is the layer that pins the router's
// findMatch <-> evaluateLazyEntry contract: the local evaluateLazyEntry wrapper
// in router.ts MUST return the Promise the async provider path produces, or
// findMatch never awaits the import and the first request to the include 404s
// (regex fallback spins to its lazy-eval cap and returns null). The helper-level
// tests in router/__tests__/async-include.test.ts cannot catch that wrapper bug
// because they call evaluateLazyEntry directly.
//
// A `() => Promise.resolve({ default: urls(...) })` provider stands in for
// `() => import("./routes")`: isIncludeProvider() keys on the function, and
// resolveIncludeModule() accepts the `{ default }` module shape.

describe("async include() via dispatch (public path)", () => {
  it("resolves a leaf async include route on first request (200, not 404)", async () => {
    let built = 0;
    const groupPatterns = urls<{}>(({ path }) => {
      built++;
      return [
        path.json("/widget", () => ({ ok: true, from: "async-group" }), {
          name: "widget",
        }),
      ];
    });
    const provider = vi.fn(async () => ({ default: groupPatterns }));

    const router = createRouter<{}>({}).routes(
      urls(({ path, include }) => [
        path.json("/", () => ({ root: true }), { name: "home" }),
        include("/group", provider, { name: "group" }),
      ]),
    ) as any;

    // Deferred: the split module is not evaluated at router construction.
    expect(provider).not.toHaveBeenCalled();
    expect(built).toBe(0);

    const res = await dispatch(router, { request: "/group/widget" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, from: "async-group" });

    // The first matching request drove the module import exactly once (the
    // provider is cached after the first resolve) — this is the "resolves once"
    // pin. The urls() handler itself is walked exactly twice: once at match-time
    // expansion, once at render-time loadManifest (the existing eager/lazy split,
    // not a re-import).
    expect(provider).toHaveBeenCalledTimes(1);
    expect(built).toBe(2);
  });

  it("resolves a NESTED async include (async provider whose module has include()) on first request", async () => {
    // Mirrors tests/cloudflare-stress-demo shop: an async provider whose module
    // itself declares eager child includes. On the first /shop/product/* request
    // findMatch must (1) await the shop provider import, (2) splice the nested
    // product entry, (3) match into it. If router.ts drops the shop promise, the
    // nested product entry is never spliced in time and the request 404s.
    const productPatterns = urls<{}>(({ path }) => [
      path.json("/:id", (ctx: { params: { id: string } }) => ({
        product: ctx.params.id,
      })),
    ]);
    const shopPatterns = urls<{}>(({ path, include }) => [
      path.json("/", () => ({ shop: "home" }), { name: "home" }),
      include("/product", productPatterns, { name: "product" }),
    ]);
    const shopProvider = vi.fn(async () => ({ default: shopPatterns }));

    const router = createRouter<{}>({}).routes(
      urls(({ path, include }) => [
        path.json("/", () => ({ root: true }), { name: "home" }),
        include("/shop", shopProvider, { name: "shop" }),
      ]),
    ) as any;

    // Shop home (direct route of the async module). The registered pattern is
    // "/shop" (include prefix + path("/")), so request without a trailing slash.
    const home = await dispatch(router, { request: "/shop" });
    expect(home.status).toBe(200);
    expect(await home.json()).toEqual({ shop: "home" });

    // Nested child route (product) reached through the async include.
    const product = await dispatch(router, { request: "/shop/product/42" });
    expect(product.status).toBe(200);
    expect(await product.json()).toEqual({ product: "42" });

    expect(shopProvider).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent first-hits through dispatch (imports once)", async () => {
    // The helper-level concurrency test (async-include.test.ts) exercises
    // evaluateLazyEntry directly; this pins the same dedup through the real
    // createRouter + dispatch path (two simultaneous first requests share one
    // in-flight import).
    const groupPatterns = urls<{}>(({ path }) => [
      path.json("/widget", () => ({ ok: true }), { name: "widget" }),
    ]);
    const provider = vi.fn(async () => {
      await Promise.resolve();
      return { default: groupPatterns };
    });
    const router = createRouter<{}>({}).routes(
      urls(({ path, include }) => [
        path.json("/", () => ({ root: true }), { name: "home" }),
        include("/group", provider, { name: "group" }),
      ]),
    ) as any;

    const [a, b] = await Promise.all([
      dispatch(router, { request: "/group/widget" }),
      dispatch(router, { request: "/group/widget" }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(provider).toHaveBeenCalledTimes(1);
  });
});

describe("async include() via generated-routes drift primitives", () => {
  // Pins the F4 fix: diffGeneratedRoutes/assertGeneratedRoutesMatch AWAIT
  // findMatch to force-expand async include() routes before reading routeMap.
  // Un-awaited (the pre-fix bug), the async route's name is reported missing.
  function routerWithAsyncInclude() {
    const groupPatterns = urls<{}>(({ path }) => [
      path.json("/widget", () => ({ ok: true }), { name: "widget" }),
    ]);
    return createRouter<{}>({}).routes(
      urls(({ path, include }) => [
        path.json("/", () => ({ root: true }), { name: "home" }),
        include("/group", async () => ({ default: groupPatterns }), {
          name: "group",
        }),
      ]),
    ) as any;
  }

  const GENERATED = { home: "/", "group.widget": "/group/widget" };

  it("diffGeneratedRoutes expands the async include (no false missing)", async () => {
    const diff = await diffGeneratedRoutes(routerWithAsyncInclude(), GENERATED);
    expect(diff.missing).toEqual([]);
    expect(diff.ok).toBe(true);
  });

  it("assertGeneratedRoutesMatch passes with an async include in sync", async () => {
    await expect(
      assertGeneratedRoutesMatch(routerWithAsyncInclude(), GENERATED),
    ).resolves.toBeUndefined();
  });
});
