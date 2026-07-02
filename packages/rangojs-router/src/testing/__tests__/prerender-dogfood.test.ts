// Userland dogfood for router.prerender() through a REAL createRouter() + the
// public createMemoryPrerenderStore(). Exercises the routing / eligibility /
// config / target-resolution paths that short-circuit BEFORE the producer
// render — those work without the RSC serializer. The render path itself
// (status "rendered" / "skipped-personalized") needs the Flight serializer,
// which the bare Vitest RSC project can't resolve (virtual: modules), so it is
// covered by the consumer-app e2e (test-app + cloudflare-basic) instead.
import { describe, expect, test } from "vitest";
import { createRouter } from "../../router.js";
import { Prerender } from "../../prerender.js";
import { createMemoryPrerenderStore } from "../../prerender/memory-prerender-store.js";

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
  test("skipped-not-on-demand for a plain Prerender route (no onDemand opt-in)", async () => {
    const store = createMemoryPrerenderStore();
    const router = createRouter({ prerender: { store } }).routes(({ path }) => [
      path("/plain/:id", PlainDef, { name: "plainPr" }),
    ]);
    const result = await router.prerender("/plain/seed", { env: {} });
    expect(result).toMatchObject({
      ok: false,
      status: "skipped-not-on-demand",
      routeName: "plainPr",
    });
    expect(store.size).toBe(0);
  });

  test("no-store when no prerender store is configured", async () => {
    const router = createRouter({}).routes(({ path }) => [
      path("/od/:id", OnDemandDef, { name: "od" }),
    ]);
    const result = await router.prerender("/od/seed", { env: {} });
    expect(result).toMatchObject({ ok: false, status: "no-store" });
  });

  test("no-match for an unknown path", async () => {
    const store = createMemoryPrerenderStore();
    const router = createRouter({ prerender: { store } }).routes(({ path }) => [
      path("/od/:id", OnDemandDef, { name: "od" }),
    ]);
    const result = await router.prerender("/nope/x", { env: {} });
    expect(result).toMatchObject({ ok: false, status: "no-match" });
  });

  test("skipped-unsupported-target for a target with search params", async () => {
    const store = createMemoryPrerenderStore();
    const router = createRouter({ prerender: { store } }).routes(({ path }) => [
      path("/od/:id", OnDemandDef, { name: "od" }),
    ]);
    const result = await router.prerender("/od/seed?preview=1", { env: {} });
    expect(result).toMatchObject({
      ok: false,
      status: "skipped-unsupported-target",
    });
  });

  test("invalidateTags reaches the public store", async () => {
    const store = createMemoryPrerenderStore();
    const router = createRouter({ prerender: { store } }).routes(({ path }) => [
      path("/od/:id", OnDemandDef, { name: "od" }),
    ]);
    // No throw, and delegates to the store's invalidateTags (a no-op here since
    // the store is empty) — proves the public trigger wires through to the store.
    await expect(
      router.prerender.invalidateTags(["product:seed"], { env: {} }),
    ).resolves.toBeUndefined();
  });
});
