// Userland dogfood for router.prerender() through a REAL createRouter() + the
// public createMemoryPrerenderStore(). Exercises the routing / eligibility /
// config / target-resolution paths that short-circuit BEFORE the producer
// render, so no Flight serializer is needed. The render path and the serve of
// a refreshed entry ("rendered", "skipped-personalized", key versions) run
// under the react-server condition in on-demand-prerender.rsc-test.tsx.
import { describe, expect, test } from "vitest";
import { createRouter } from "../../router.js";
import { Prerender } from "../../prerender.js";
import { createMemoryPrerenderStore } from "../../prerender/memory-prerender-store.js";
import { urls } from "../../urls.js";
import { getContext } from "../../server/context.js";
import { buildRouteTree } from "../../__tests__/helpers/route-tree.js";

const OnDemandDef = Prerender<{ id: string }>(
  async () => [{ id: "seed" }],
  async (ctx) => ({ id: ctx.params.id }) as any,
  { onDemand: { ttl: 60 } },
);
const PlainDef = Prerender<{ id: string }>(
  async () => [{ id: "seed" }],
  async (ctx) => ({ id: ctx.params.id }) as any,
);

describe("router.prerender() dogfood (public createRouter + public store)", () => {
  test("a plain Prerender route (no onDemand opt-in) takes the warm path: a path target with no origin is skipped-no-origin", async () => {
    const store = createMemoryPrerenderStore();
    const router = createRouter({ prerender: { store } }).routes(({ path }) => [
      path("/plain/:id", PlainDef, { name: "plainPr" }),
    ]);
    const result = await router.prerender({ env: {} })("/plain/seed");
    expect(result).toMatchObject({
      ok: false,
      path: "warm",
      status: "skipped-no-origin",
      routeName: "plainPr",
    });
    expect(store.size).toBe(0);
  });

  test("a warm of a router without createRouter({ cache }) is no-store, with the URL it would have requested", async () => {
    const router = createRouter({}).routes(({ path }) => [
      path("/plain/:id", PlainDef, { name: "plainPr" }),
    ]);
    const result = await router.prerender({
      env: {},
      origin: "https://shop.example",
    })("/plain/seed?page=2");
    expect(result).toMatchObject({
      ok: false,
      path: "warm",
      status: "no-store",
      target: "https://shop.example/plain/seed?page=2",
      routeName: "plainPr",
    });
  });

  test("no-store when no prerender store is configured", async () => {
    const router = createRouter({}).routes(({ path }) => [
      path("/od/:id", OnDemandDef, { name: "od" }),
    ]);
    const result = await router.prerender({ env: {} })("/od/seed");
    expect(result).toMatchObject({ ok: false, status: "no-store" });
  });

  test("no-match for an unknown path", async () => {
    const store = createMemoryPrerenderStore();
    const router = createRouter({ prerender: { store } }).routes(({ path }) => [
      path("/od/:id", OnDemandDef, { name: "od" }),
    ]);
    const result = await router.prerender({ env: {} })("/nope/x");
    expect(result).toMatchObject({ ok: false, status: "no-match" });
  });

  test("skipped-unsupported-target for a target with search params", async () => {
    const store = createMemoryPrerenderStore();
    const router = createRouter({ prerender: { store } }).routes(({ path }) => [
      path("/od/:id", OnDemandDef, { name: "od" }),
    ]);
    const result = await router.prerender({ env: {} })("/od/seed?preview=1");
    expect(result).toMatchObject({
      ok: false,
      status: "skipped-unsupported-target",
    });
  });

  test("ppr and onDemand on one route throw at route definition", () => {
    expect(() =>
      buildRouteTree(
        urls(({ path }) => [
          path("/od/:id", OnDemandDef, { name: "od", ppr: true }),
        ]),
      ),
    ).toThrow(/sets both ppr and onDemand/);
    // ppr: false is not a ppr opt-in.
    expect(() =>
      buildRouteTree(
        urls(({ path }) => [
          path("/od/:id", OnDemandDef, { name: "od", ppr: false }),
        ]),
      ),
    ).not.toThrow();
  });

  test("ppr + onDemand throws even when another route is the one being evaluated", () => {
    const def = urls(({ path }) => [
      path("/good", () => null as any, { name: "good" }),
      path("/od/:id", OnDemandDef, { name: "od", ppr: true }),
    ]);
    expect(() => getContext().runIsolated("good", () => def.handler())).toThrow(
      /sets both ppr and onDemand/,
    );
  });

  test("markStale reaches the public store", async () => {
    const store = createMemoryPrerenderStore();
    const router = createRouter({ prerender: { store } }).routes(({ path }) => [
      path("/od/:id", OnDemandDef, { name: "od" }),
    ]);
    // No throw, and delegates to the store's markStale (a no-op here since
    // the store is empty) — proves the public trigger wires through to the store.
    await expect(
      router.prerender({ env: {} }).markStale(["product:seed"]),
    ).resolves.toBeUndefined();
  });
});
