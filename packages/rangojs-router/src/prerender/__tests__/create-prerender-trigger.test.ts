import { describe, it, expect, vi } from "vitest";
import {
  createPrerenderTrigger,
  PrerenderError,
  type PrerenderTriggerDeps,
  type ProducerOutput,
} from "../create-prerender-trigger.js";
import { createMemoryPrerenderStore } from "../memory-prerender-store.js";
import { PrerenderPersonalizationError } from "../producer-guard.js";
import { serializePrerenderKey } from "../writable-store.js";
import { hashParams } from "../param-hash.js";
import type { PrerenderConfig } from "../on-demand.js";

// A minimal producer output for a route named "products.detail" with { id }.
function output(overrides: Partial<ProducerOutput> = {}): ProducerOutput {
  return {
    segments: [{ id: "s0", encoded: "x" } as any],
    handles: "",
    routeName: "products.detail",
    params: { id: "42" },
    ...overrides,
  };
}

interface HarnessOptions {
  config?: PrerenderConfig | undefined;
  match?: PrerenderTriggerDeps["matchRoute"];
  runProducer?: PrerenderTriggerDeps["runProducer"];
  reverse?: PrerenderTriggerDeps["reverse"];
  buildId?: string;
}

function harness(opts: HarnessOptions = {}) {
  const store = createMemoryPrerenderStore();
  // "config" in opts distinguishes an explicit `config: undefined` (no store)
  // from an omitted config (default to the fake store).
  const config: PrerenderConfig | undefined =
    "config" in opts ? opts.config : { store };
  const ensureManifest = vi.fn(async () => {});
  const deps: PrerenderTriggerDeps = {
    routerId: "r1",
    buildId: opts.buildId ?? "b1",
    isDev: () => false,
    ensureManifest,
    resolveConfig: () => config,
    reverse:
      opts.reverse ??
      ((route, params) =>
        route === "products.detail" ? `/products/${params.id}` : undefined),
    matchRoute:
      opts.match ??
      ((pathname) =>
        pathname.startsWith("/products/")
          ? {
              routeName: "products.detail",
              params: { id: pathname.split("/")[2] },
              isOnDemand: true,
              isPassthrough: false,
            }
          : null),
    runProducer: opts.runProducer ?? (async () => output()),
  };
  const trigger = createPrerenderTrigger(deps);
  return { trigger, store, deps, ensureManifest, config };
}

describe("createPrerenderTrigger", () => {
  it("renders and stores an on-demand route (string target)", async () => {
    const { trigger, store } = harness();
    const result = await trigger("/products/42", { env: {} });
    expect(result).toMatchObject({
      ok: true,
      status: "rendered",
      target: "/products/42",
      routeName: "products.detail",
      tags: [],
    });
    if (!result.ok) throw new Error("expected ok");
    const stored = store.peek({
      routerId: "r1",
      buildId: "b1",
      routeName: "products.detail",
      paramHash: hashParams({ id: "42" }),
    });
    expect(stored?.entry.segments.length).toBe(1);
    expect(result.key).toBe(
      serializePrerenderKey({
        routerId: "r1",
        buildId: "b1",
        routeName: "products.detail",
        paramHash: hashParams({ id: "42" }),
      }),
    );
  });

  it("accepts a typed object target and reverses it", async () => {
    const reverse = vi.fn(
      (route: string, params: Record<string, string>) =>
        `/products/${params.id}`,
    );
    const { trigger, store } = harness({ reverse });
    const result = await trigger(
      { route: "products.detail", params: { id: "42" } } as any,
      { env: {} },
    );
    expect(reverse).toHaveBeenCalledWith("products.detail", { id: "42" });
    expect(result.ok).toBe(true);
    expect(store.size).toBe(1);
  });

  it("returns skipped-unsupported-target for search/hash targets", async () => {
    const { trigger, store } = harness();
    for (const target of ["/products/42?preview=1", "/products/42#top"]) {
      const result = await trigger(target, { env: {} });
      expect(result).toMatchObject({
        ok: false,
        status: "skipped-unsupported-target",
      });
    }
    expect(store.size).toBe(0);
  });

  it("returns no-match for an unknown route object", async () => {
    const { trigger } = harness();
    const result = await trigger({ route: "nope", params: {} } as any, {
      env: {},
    });
    expect(result).toMatchObject({ ok: false, status: "no-match" });
  });

  it("returns no-match when nothing matches the pathname", async () => {
    const { trigger } = harness();
    const result = await trigger("/unknown", { env: {} });
    expect(result).toMatchObject({ ok: false, status: "no-match" });
  });

  it("returns skipped-not-on-demand when the route did not opt in", async () => {
    const { trigger } = harness({
      match: () => ({
        routeName: "products.detail",
        params: { id: "42" },
        isOnDemand: false,
        isPassthrough: false,
      }),
    });
    const result = await trigger("/products/42", { env: {} });
    expect(result).toMatchObject({
      ok: false,
      status: "skipped-not-on-demand",
      routeName: "products.detail",
    });
  });

  it("returns no-store when no prerender store is configured", async () => {
    const { trigger } = harness({ config: undefined });
    const result = await trigger("/products/42", { env: {} });
    expect(result).toMatchObject({ ok: false, status: "no-store" });
  });

  it("maps a render throw to render-failed and keeps the store untouched", async () => {
    const { trigger, store } = harness({
      runProducer: async () => {
        throw new Error("upstream 500");
      },
    });
    const result = await trigger("/products/42", { env: {} });
    expect(result).toMatchObject({ ok: false, status: "render-failed" });
    if (result.ok) throw new Error("expected fail");
    expect((result.error as Error).message).toBe("upstream 500");
    expect(store.size).toBe(0);
  });

  it("maps a personalization throw to skipped-personalized", async () => {
    const { trigger, store } = harness({
      runProducer: async () => {
        throw new PrerenderPersonalizationError("cookies()");
      },
    });
    const result = await trigger("/products/42", { env: {} });
    expect(result).toMatchObject({
      ok: false,
      status: "skipped-personalized",
    });
    expect(store.size).toBe(0);
  });

  it("maps a passthrough sentinel to skipped-passthrough", async () => {
    const { trigger, store } = harness({
      runProducer: async () => output({ passthrough: true }),
    });
    const result = await trigger("/products/42", { env: {} });
    expect(result).toMatchObject({ ok: false, status: "skipped-passthrough" });
    expect(store.size).toBe(0);
  });

  it("returns store-failed and keeps the previous entry when set throws", async () => {
    const failingStore = createMemoryPrerenderStore();
    failingStore.set = async () => {
      throw new Error("kv down");
    };
    const { trigger } = harness({ config: { store: failingStore } });
    const result = await trigger("/products/42", { env: {} });
    expect(result).toMatchObject({ ok: false, status: "store-failed" });
  });

  it("resolves ttl and tags from the route's onDemand config", async () => {
    const { trigger, store } = harness({
      runProducer: async () =>
        output({
          onDemandConfig: {
            ttl: 120,
            tags: ({ params }) => [`product:${params.id}`],
          },
        }),
    });
    const result = await trigger("/products/42", { env: {} });
    expect(result).toMatchObject({
      ok: true,
      status: "rendered",
      ttl: 120,
      tags: ["product:42"],
    });
    const stored = store.entries()[0][1];
    expect(stored.meta.tags).toEqual(["product:42"]);
    expect(stored.meta.staleAt).toBeDefined();
  });

  it("falls back to router defaultTtl when the route has no onDemand config", async () => {
    const store = createMemoryPrerenderStore();
    const { trigger } = harness({ config: { store, defaultTtl: 300 } });
    const result = await trigger("/products/42", { env: {} });
    expect(result).toMatchObject({ ok: true, ttl: 300 });
  });

  describe("onlyIfStale", () => {
    it("returns already-fresh without rendering when the entry is fresh", async () => {
      const store = createMemoryPrerenderStore();
      const runProducer = vi.fn(async () =>
        output({ onDemandConfig: { ttl: 3600 } }),
      );
      const { trigger } = harness({ config: { store }, runProducer });
      // Seed a fresh entry.
      await trigger("/products/42", { env: {} });
      runProducer.mockClear();
      const result = await trigger("/products/42", {
        env: {},
        onlyIfStale: true,
      });
      expect(result).toMatchObject({ ok: true, status: "already-fresh" });
      expect(runProducer).not.toHaveBeenCalled();
    });

    it("falls through to render (does not throw) when the stale-check read fails", async () => {
      const store = createMemoryPrerenderStore();
      store.get = async () => {
        throw new Error("kv read blip");
      };
      const runProducer = vi.fn(async () => output());
      const { trigger } = harness({ config: { store }, runProducer });
      // A throwing stale-check must not escape as a rejection (would abort a
      // many() batch); it renders instead.
      const result = await trigger("/products/42", {
        env: {},
        onlyIfStale: true,
      });
      expect(result).toMatchObject({ ok: true, status: "rendered" });
      expect(runProducer).toHaveBeenCalledTimes(1);
    });

    it("renders when the existing entry is stale", async () => {
      let now = 1000;
      const store = createMemoryPrerenderStore({ now: () => now });
      const runProducer = vi.fn(async () =>
        output({ onDemandConfig: { ttl: 1 } }),
      );
      const { trigger } = harness({ config: { store }, runProducer });
      await trigger("/products/42", { env: {} }); // staleAt = 1000 + 1000ms
      runProducer.mockClear();
      now = 5000; // past staleAt
      const result = await trigger("/products/42", {
        env: {},
        onlyIfStale: true,
      });
      expect(result).toMatchObject({ ok: true, status: "rendered" });
      expect(runProducer).toHaveBeenCalledTimes(1);
    });
  });

  describe("throwOnError", () => {
    it("throws a PrerenderError on a failed result", async () => {
      const { trigger } = harness({
        runProducer: async () => {
          throw new Error("boom");
        },
      });
      await expect(
        trigger("/products/42", { env: {}, throwOnError: true }),
      ).rejects.toBeInstanceOf(PrerenderError);
    });

    it("does not throw on success", async () => {
      const { trigger } = harness();
      const result = await trigger("/products/42", {
        env: {},
        throwOnError: true,
      });
      expect(result.ok).toBe(true);
    });
  });

  describe("many()", () => {
    it("returns one result per target and respects concurrency", async () => {
      const { trigger, store } = harness();
      const results = await trigger.many(
        ["/products/1", "/products/2", "/products/3"],
        { env: {}, concurrency: 2 },
      );
      expect(results).toHaveLength(3);
      expect(results.every((r) => r.ok)).toBe(true);
      expect(store.size).toBe(3);
    });

    it("defaults an invalid concurrency (NaN/undefined/<1) to 1 without dropping targets", async () => {
      const { trigger, store } = harness();
      for (const concurrency of [NaN, 0, -3, undefined as any]) {
        store.clear();
        const results = await trigger.many(["/products/1", "/products/2"], {
          env: {},
          concurrency,
        });
        expect(results).toHaveLength(2);
        expect(results.every((r) => r.ok)).toBe(true);
        expect(store.size).toBe(2);
      }
    });

    it("a throwing tags() callback maps to store-failed, not a batch abort", async () => {
      const { trigger } = harness({
        runProducer: async () =>
          output({
            onDemandConfig: {
              tags: () => {
                throw new Error("bad tags fn");
              },
            },
          }),
      });
      const results = await trigger.many(["/products/1", "/products/2"], {
        env: {},
      });
      // Both targets return a result (the throw did not abort the batch).
      expect(results).toHaveLength(2);
      expect(results.every((r) => !r.ok && r.status === "store-failed")).toBe(
        true,
      );
    });

    it("collects failures without stopping the batch (no throwOnError)", async () => {
      const { trigger } = harness({
        match: (pathname) =>
          pathname === "/products/2"
            ? null
            : {
                routeName: "products.detail",
                params: { id: pathname.split("/")[2] },
                isOnDemand: true,
                isPassthrough: false,
              },
      });
      const results = await trigger.many(["/products/1", "/products/2"], {
        env: {},
      });
      expect(results[0].ok).toBe(true);
      expect(results[1]).toMatchObject({ ok: false, status: "no-match" });
    });
  });

  describe("invalidateTags()", () => {
    it("delegates to the store", async () => {
      const store = createMemoryPrerenderStore();
      const spy = vi.spyOn(store, "invalidateTags");
      const { trigger } = harness({ config: { store } });
      await trigger.invalidateTags(["product:42"], { env: {} });
      expect(spy).toHaveBeenCalledWith(["product:42"]);
    });

    it("is a no-op with no tags or no store", async () => {
      const { trigger } = harness({ config: undefined });
      await expect(
        trigger.invalidateTags(["x"], { env: {} }),
      ).resolves.toBeUndefined();
    });
  });
});
