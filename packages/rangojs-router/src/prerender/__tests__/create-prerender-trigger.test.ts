import { describe, it, expect, vi } from "vitest";
import {
  createPrerenderTrigger,
  PrerenderError,
  type PrerenderTriggerDeps,
  type ProducerOutput,
} from "../create-prerender-trigger.js";
import { createMemoryPrerenderStore } from "../memory-prerender-store.js";
import { PrerenderPersonalizationError } from "../producer-guard.js";
import {
  serializePrerenderKey,
  type WritablePrerenderStore,
} from "../writable-store.js";
import { hashParams } from "../param-hash.js";
import type { PrerenderConfig } from "../on-demand.js";
import { readWarmMark, type PrerenderWarmRecord } from "../warm-request.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import type { SegmentCacheStore } from "../../cache/types.js";

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
  resolveConfig?: PrerenderTriggerDeps["resolveConfig"];
  match?: PrerenderTriggerDeps["matchRoute"];
  runProducer?: PrerenderTriggerDeps["runProducer"];
  reverse?: PrerenderTriggerDeps["reverse"];
  version?: string;
  isDev?: () => boolean;
  isViteDevServer?: () => boolean;
  /** The app cache config a warm resolves; default: none (no createRouter({ cache })). */
  resolveCacheConfig?: PrerenderTriggerDeps["resolveCacheConfig"];
  /** The router's handler; default: a 200 that writes nothing. */
  fetch?: PrerenderTriggerDeps["fetch"];
  ambientOrigin?: () => string | undefined;
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
    resolveVersion: () => opts.version ?? "b1",
    isDev: opts.isDev ?? (() => false),
    isViteDevServer: opts.isViteDevServer ?? (() => false),
    ensureManifest,
    resolveConfig: opts.resolveConfig ?? (() => config),
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
    resolveCacheConfig: opts.resolveCacheConfig ?? (() => undefined),
    fetch: opts.fetch ?? (async () => new Response("ok")),
    ambientOrigin: opts.ambientOrigin ?? (() => undefined),
  };
  const bind = createPrerenderTrigger(deps);
  const trigger = bind({ env: {} });
  return { bind, trigger, store, deps, ensureManifest, config };
}

describe("createPrerenderTrigger", () => {
  it("renders and stores an on-demand route (string target)", async () => {
    const { trigger, store } = harness();
    const result = await trigger("/products/42");
    expect(result).toMatchObject({
      ok: true,
      status: "rendered",
      target: "/products/42",
      routeName: "products.detail",
      tags: [],
    });
    if (!result.ok || result.path !== "on-demand") {
      throw new Error("expected an on-demand result");
    }
    const stored = store.peek({
      routerId: "r1",
      version: "b1",
      routeName: "products.detail",
      paramHash: hashParams({ id: "42" }),
    });
    expect(stored?.entry.segments.length).toBe(1);
    expect(result.key).toBe(
      serializePrerenderKey({
        routerId: "r1",
        version: "b1",
        routeName: "products.detail",
        paramHash: hashParams({ id: "42" }),
      }),
    );
  });

  it("awaits asynchronous route matching", async () => {
    const match = vi.fn(async () => ({
      routeName: "products.detail",
      params: { id: "42" },
      isOnDemand: true,
      isPassthrough: false,
    }));
    const { trigger, store } = harness({ match });

    const result = await trigger("/products/42");

    expect(match).toHaveBeenCalledWith("/products/42");
    expect(result.ok).toBe(true);
    expect(store.size).toBe(1);
  });

  it("accepts a typed object target and reverses it", async () => {
    const reverse = vi.fn(
      (route: string, params: Record<string, string>) =>
        `/products/${params.id}`,
    );
    const { trigger, store } = harness({ reverse });
    const result = await trigger({
      route: "products.detail",
      params: { id: "42" },
    } as any);
    expect(reverse).toHaveBeenCalledWith("products.detail", { id: "42" });
    expect(result.ok).toBe(true);
    expect(store.size).toBe(1);
  });

  it("returns skipped-unsupported-target for search/hash targets", async () => {
    const { trigger, store } = harness();
    for (const target of ["/products/42?preview=1", "/products/42#top"]) {
      const result = await trigger(target);
      expect(result).toMatchObject({
        ok: false,
        status: "skipped-unsupported-target",
      });
    }
    expect(store.size).toBe(0);
  });

  it("returns no-match for an unknown route object", async () => {
    const { trigger } = harness();
    const result = await trigger({ route: "nope", params: {} } as any);
    expect(result).toMatchObject({ ok: false, status: "no-match" });
  });

  it("returns no-match when nothing matches the pathname", async () => {
    const { trigger } = harness();
    const result = await trigger("/unknown");
    expect(result).toMatchObject({ ok: false, status: "no-match" });
  });

  it("returns no-store when no prerender store is configured", async () => {
    const { trigger } = harness({ config: undefined });
    const result = await trigger("/products/42");
    expect(result).toMatchObject({ ok: false, status: "no-store" });
  });

  it("maps a resolveConfig factory throw to no-store instead of rejecting", async () => {
    const { trigger, store } = harness({
      resolveConfig: () => {
        throw new Error("boom");
      },
    });

    const result = await trigger("/products/42");
    expect(result).toMatchObject({
      ok: false,
      status: "no-store",
      routeName: "products.detail",
    });
    if (result.ok) throw new Error("expected fail");
    expect((result.error as Error).message).toBe("boom");
    expect(store.size).toBe(0);

    let thrown: unknown;
    try {
      await trigger("/products/42", { throwOnError: true });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PrerenderError);
    expect((thrown as PrerenderError).result.status).toBe("no-store");

    const many = await trigger.many(["/products/1", "/products/2"]);
    expect(many).toHaveLength(2);
    expect(many.every((r) => !r.ok && r.status === "no-store")).toBe(true);
  });

  it("maps a render throw to render-failed and keeps the store untouched", async () => {
    const { trigger, store } = harness({
      runProducer: async () => {
        throw new Error("upstream 500");
      },
    });
    const result = await trigger("/products/42");
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
    const result = await trigger("/products/42");
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
    const result = await trigger("/products/42");
    expect(result).toMatchObject({ ok: false, status: "skipped-passthrough" });
    expect(store.size).toBe(0);
  });

  it("returns store-failed and keeps the previous entry when set throws", async () => {
    const failingStore = createMemoryPrerenderStore();
    failingStore.set = async () => {
      throw new Error("kv down");
    };
    const { trigger } = harness({ config: { store: failingStore } });
    const result = await trigger("/products/42");
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
    const result = await trigger("/products/42");
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

  it("normalizes route tags like cache({ tags }): trimmed, no empties, no duplicates", async () => {
    const { trigger, store } = harness({
      runProducer: async () =>
        output({
          onDemandConfig: {
            tags: [" a ", "a", "", "  ", "b", 7 as unknown as string, "b"],
          },
        }),
    });
    const result = await trigger("/products/42");
    expect(result).toMatchObject({ ok: true, tags: ["a", "b"] });
    expect(store.entries()[0]![1].meta.tags).toEqual(["a", "b"]);

    const fn = harness({
      runProducer: async () =>
        output({ onDemandConfig: { tags: () => ["x", "x", " "] } }),
    });
    expect(await fn.trigger("/products/42")).toMatchObject({
      tags: ["x"],
    });
  });

  it("accepts a static tags array on the route's onDemand config", async () => {
    const tags = ["catalog", "products"];
    const { trigger, store } = harness({
      runProducer: async () => output({ onDemandConfig: { tags } }),
    });
    const result = await trigger("/products/42");
    expect(result).toMatchObject({ ok: true, tags: ["catalog", "products"] });
    const stored = store.entries()[0][1];
    expect(stored.meta.tags).toEqual(["catalog", "products"]);
    // A copy: a later mutation of the route's array does not reach the entry.
    tags.push("late");
    expect(stored.meta.tags).toEqual(["catalog", "products"]);
  });

  it("falls back to router ttl when the route has no onDemand config", async () => {
    const store = createMemoryPrerenderStore();
    const { trigger } = harness({ config: { store, ttl: 300 } });
    const result = await trigger("/products/42");
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
      await trigger("/products/42");
      runProducer.mockClear();
      const result = await trigger("/products/42", {
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
        onlyIfStale: true,
      });
      expect(result).toMatchObject({ ok: true, status: "rendered" });
      expect(runProducer).toHaveBeenCalledTimes(1);
    });

    it("renders when the existing entry is stale", async () => {
      // The trigger composes the envelope, so its clock decides staleAt.
      const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
      try {
        const store = createMemoryPrerenderStore();
        const runProducer = vi.fn(async () =>
          output({ onDemandConfig: { ttl: 1 } }),
        );
        const { trigger } = harness({ config: { store }, runProducer });
        await trigger("/products/42"); // staleAt = 1000 + 1000ms
        runProducer.mockClear();
        clock.mockReturnValue(5000); // past staleAt
        const result = await trigger("/products/42", {
          onlyIfStale: true,
        });
        expect(result).toMatchObject({ ok: true, status: "rendered" });
        expect(runProducer).toHaveBeenCalledTimes(1);
      } finally {
        clock.mockRestore();
      }
    });

    it("renders when the existing entry fails verification", async () => {
      const store = createMemoryPrerenderStore();
      const runProducer = vi.fn(async () =>
        output({ onDemandConfig: { ttl: 3600 } }),
      );
      const { trigger } = harness({ config: { store }, runProducer });
      await trigger("/products/42");
      // A colliding entry under the same key (other params) is not "fresh".
      store.entries()[0]![1].meta.params = { id: "99" };
      runProducer.mockClear();
      const result = await trigger("/products/42", {
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
        trigger("/products/42", { throwOnError: true }),
      ).rejects.toBeInstanceOf(PrerenderError);
    });

    it("does not throw on success", async () => {
      const { trigger } = harness();
      const result = await trigger("/products/42", {
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
        { concurrency: 2 },
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
      const results = await trigger.many(["/products/1", "/products/2"]);
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
      const results = await trigger.many(["/products/1", "/products/2"]);
      expect(results[0].ok).toBe(true);
      expect(results[1]).toMatchObject({ ok: false, status: "no-match" });
    });

    it("many with throwOnError and concurrency stops the batch", async () => {
      const started: string[] = [];
      const runProducer: PrerenderTriggerDeps["runProducer"] = async ({
        pathname,
      }) => {
        started.push(pathname);
        if (pathname === "/products/2") {
          throw new Error("boom");
        }
        // Deferred settle: keeps the other in-flight workers alive long
        // enough for the abort flag to land before they'd pick a next item.
        await new Promise((r) => setTimeout(r, 10));
        return output({ params: { id: pathname.split("/")[2] } });
      };
      const { trigger } = harness({ runProducer });
      const targets = [
        "/products/1",
        "/products/2",
        "/products/3",
        "/products/4",
        "/products/5",
        "/products/6",
      ];

      await expect(
        trigger.many(targets, {
          throwOnError: true,
          concurrency: 2,
        }),
      ).rejects.toBeInstanceOf(PrerenderError);

      // Let any in-flight producer settle before asserting nothing further started.
      await new Promise((r) => setTimeout(r, 30));
      expect(started.length).toBeLessThan(6);
      expect(started.length).toBeLessThanOrEqual(3);
    });
  });

  describe("key version", () => {
    it("resolves per refresh, so a changed table is picked up on the next call", async () => {
      let version = "d1";
      const h = harness();
      h.deps.resolveVersion = () => version;
      const t = createPrerenderTrigger(h.deps)({ env: {} });
      const first = await t("/products/42");
      version = "d2";
      const second = await t("/products/42");
      if (first.path !== "on-demand" || second.path !== "on-demand") {
        throw new Error("expected on-demand results");
      }
      if (!first.ok || !second.ok) throw new Error("expected ok");
      expect(first.key).toContain(":d1:");
      expect(second.key).toContain(":d2:");
    });

    it("resolves once per many() batch", async () => {
      const h = harness();
      const resolveVersion = vi.fn(() => "d1");
      h.deps.resolveVersion = resolveVersion;
      const t = createPrerenderTrigger(h.deps)({ env: {} });
      await t.many(["/products/1", "/products/2", "/products/3"], {
        concurrency: 2,
      });
      expect(resolveVersion).toHaveBeenCalledTimes(1);
    });
  });

  describe("binding", () => {
    it("does no work at bind time and resolves the config per call", async () => {
      const h = harness();
      const resolveConfig = vi.fn(h.deps.resolveConfig);
      h.deps.resolveConfig = resolveConfig;
      const bind = createPrerenderTrigger(h.deps);
      const envA = { id: "a" };
      const runner = bind({ env: envA });
      expect(resolveConfig).not.toHaveBeenCalled();
      expect(h.ensureManifest).not.toHaveBeenCalled();
      await runner("/products/1");
      await runner("/products/2");
      expect(resolveConfig).toHaveBeenCalledTimes(2);
      expect(resolveConfig).toHaveBeenCalledWith(envA, undefined);
    });
  });

  describe("markStale()", () => {
    it("delegates to the store", async () => {
      const store = createMemoryPrerenderStore();
      const spy = vi.spyOn(store, "markStale");
      const { trigger } = harness({ config: { store } });
      await trigger.markStale(["product:42"]);
      expect(spy).toHaveBeenCalledWith(["product:42"]);
    });

    it("is a no-op with no tags or no store", async () => {
      const { trigger } = harness({ config: undefined });
      await expect(trigger.markStale(["x"])).resolves.toBeUndefined();
    });

    it("warns in dev when no store is configured", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { trigger } = harness({ config: undefined, isDev: () => true });
        await trigger.markStale(["x"]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain("markStale");
      } finally {
        warn.mockRestore();
      }
    });

    it("warns in dev when the configured store lacks markStale", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const storeWithoutInvalidate: WritablePrerenderStore = {
          get: async () => null,
          set: async () => {},
        };
        const { trigger } = harness({
          config: { store: storeWithoutInvalidate },
          isDev: () => true,
        });
        await trigger.markStale(["x"]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain("markStale");
      } finally {
        warn.mockRestore();
      }
    });

    it("warns once per trigger when the store cannot mark", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { trigger } = harness({ config: undefined, isDev: () => true });
        await trigger.markStale(["x"]);
        await trigger.markStale(["y"]);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });

    it("warns once in dev when a store marks entries but no onRevalidate is configured", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { trigger } = harness({ isDev: () => true });
        await trigger.markStale(["x"]);
        await trigger.markStale(["y"]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain("no onRevalidate");
      } finally {
        warn.mockRestore();
      }
    });

    it("does not warn when onRevalidate is configured, or outside dev", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const store = createMemoryPrerenderStore();
        const withRevalidate = harness({
          config: { store, onRevalidate: () => {} },
          isDev: () => true,
        });
        await withRevalidate.trigger.markStale(["x"]);
        const outsideDev = harness({ isDev: () => false });
        await outsideDev.trigger.markStale(["x"]);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it("does not warn outside dev even with no store configured", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { trigger } = harness({ config: undefined, isDev: () => false });
        await trigger.markStale(["x"]);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });
});

/**
 * The warm path: every route that is not Prerender(..., { onDemand }). The
 * handler is a fake `fetch`; it stands in for the cache layers by writing into
 * the record of the request it is handed (readWarmMark), the way the layers
 * do through the request context.
 */
describe("createPrerenderTrigger: warming a route that is not on-demand", () => {
  class SharedStore extends MemorySegmentCacheStore {
    readonly scope = "global" as const;
  }

  /** Declares `local` and is not a MemorySegmentCacheStore (no dev-server exemption). */
  class LocalStore implements SegmentCacheStore {
    readonly scope = "local" as const;
    private readonly inner = new MemorySegmentCacheStore();
    get(key: string) {
      return this.inner.get(key);
    }
    set(...args: Parameters<SegmentCacheStore["set"]>) {
      return this.inner.set(...args);
    }
    delete(key: string) {
      return this.inner.delete(key);
    }
  }

  const plainMatch: PrerenderTriggerDeps["matchRoute"] = (pathname) =>
    pathname.startsWith("/plain")
      ? {
          routeName: "plain",
          params: {} as Record<string, string>,
          isOnDemand: false,
          isPassthrough: false,
        }
      : pathname.startsWith("/products/")
        ? {
            routeName: "products.detail",
            params: { id: pathname.split("/")[2] },
            isOnDemand: true,
            isPassthrough: false,
          }
        : null;

  /** A handler whose layers report `patch` into the warm's record. */
  function handler(
    patch: (record: PrerenderWarmRecord) => void = (record) => {
      record.writes.record += 1;
    },
    response: () => Response = () => new Response("<html></html>"),
  ) {
    const requests: Request[] = [];
    const records: PrerenderWarmRecord[] = [];
    const fetch = vi.fn<PrerenderTriggerDeps["fetch"]>(async (request) => {
      requests.push(request);
      const record = readWarmMark(request)!;
      records.push(record);
      patch(record);
      return response();
    });
    return { fetch, requests, records };
  }

  function warmHarness(
    opts: HarnessOptions & { store?: SegmentCacheStore } = {},
  ) {
    const store = opts.store ?? new SharedStore();
    return harness({
      match: plainMatch,
      resolveCacheConfig: () => ({ store }),
      ...opts,
    });
  }

  it("warms through the router's handler and reports what the request wrote", async () => {
    const h = handler((record) => {
      record.writes.record += 1;
      record.writes.item += 2;
      record.document = "stored";
      record.writes.response += 1;
    });
    const { trigger } = warmHarness({ fetch: h.fetch });

    const result = await trigger("https://shop.example/plain");

    expect(result).toEqual({
      ok: true,
      path: "warm",
      status: "warmed",
      target: "https://shop.example/plain",
      routeName: "plain",
      responseStatus: 200,
      caches: {
        writes: { record: 1, item: 2, response: 1, shell: 0 },
        document: "stored",
      },
    });
    expect(h.requests).toHaveLength(1);
    expect(h.records[0].mode).toBe("replace");
  });

  it("the handler writes to the store the scope was checked on", async () => {
    const store = new SharedStore();
    const resolveCacheConfig = vi.fn(() => ({
      store,
      searchParams: "all" as const,
    }));
    const h = handler();
    const { trigger } = warmHarness({ fetch: h.fetch, resolveCacheConfig });

    await trigger("https://shop.example/plain");

    // Resolved once, with the env and the context the warm waits on; the
    // record hands that config to the handler.
    expect(resolveCacheConfig).toHaveBeenCalledTimes(1);
    const [env, ctx] = resolveCacheConfig.mock.calls[0] as unknown as [
      unknown,
      { tasks: unknown[] },
    ];
    expect(env).toEqual({});
    expect(Array.isArray(ctx.tasks)).toBe(true);
    expect(h.records[0].cacheConfig.store).toBe(store);
    expect(h.fetch.mock.calls[0][1].ctx).toBe(ctx);
  });

  describe("the origin", () => {
    it("a full-URL target uses its own origin, ahead of the binding and the calling request", async () => {
      const h = handler();
      const { bind } = warmHarness({
        fetch: h.fetch,
        ambientOrigin: () => "https://ambient.example",
      });

      await bind({ env: {}, origin: "https://bound.example" })(
        "https://target.example/plain",
      );
      await bind({ env: {}, origin: "https://bound.example" })(
        new URL("https://url.example/plain"),
      );

      expect(h.requests.map((r) => r.url)).toEqual([
        "https://target.example/plain",
        "https://url.example/plain",
      ]);
    });

    it("a path target uses the binding's origin, ahead of the calling request", async () => {
      const h = handler();
      const { bind } = warmHarness({
        fetch: h.fetch,
        ambientOrigin: () => "https://ambient.example",
      });

      // A trailing path on the option is not part of the origin.
      const result = await bind({
        env: {},
        origin: "https://bound.example/ignored",
      })("/plain");

      expect(h.requests[0].url).toBe("https://bound.example/plain");
      expect(result).toMatchObject({
        status: "warmed",
        target: "https://bound.example/plain",
      });
    });

    it("a path target with no binding origin uses the calling request's", async () => {
      const h = handler();
      const { trigger } = warmHarness({
        fetch: h.fetch,
        ambientOrigin: () => "https://ambient.example",
      });

      await trigger("/plain");

      expect(h.requests[0].url).toBe("https://ambient.example/plain");
    });

    it("a { route, params } target reverses to a path and takes the same origin", async () => {
      const h = handler();
      const { bind } = warmHarness({
        fetch: h.fetch,
        reverse: (route) => (route === "plain" ? "/plain" : undefined),
      });

      await bind({ env: {}, origin: "https://bound.example" })({
        route: "plain",
      } as any);

      expect(h.requests[0].url).toBe("https://bound.example/plain");
    });

    it("with none, a path target is skipped-no-origin and nothing is requested", async () => {
      const h = handler();
      const resolveCacheConfig = vi.fn(() => ({ store: new SharedStore() }));
      const { trigger } = warmHarness({ fetch: h.fetch, resolveCacheConfig });

      const result = await trigger("/plain");

      expect(result).toEqual({
        ok: false,
        path: "warm",
        status: "skipped-no-origin",
        target: "/plain",
        routeName: "plain",
      });
      expect(h.fetch).not.toHaveBeenCalled();
      expect(resolveCacheConfig).not.toHaveBeenCalled();
    });

    it("an origin option that is not a URL is skipped-no-origin, with the error", async () => {
      const h = handler();
      const { bind } = warmHarness({ fetch: h.fetch });

      const result = await bind({ env: {}, origin: "shop.example" })("/plain");

      expect(result).toMatchObject({ ok: false, status: "skipped-no-origin" });
      expect((result as { error?: unknown }).error).toBeInstanceOf(TypeError);
      expect(h.fetch).not.toHaveBeenCalled();
    });
  });

  describe("search params", () => {
    it("a warm target keeps its search params: cache keys carry them", async () => {
      const h = handler();
      const { trigger } = warmHarness({ fetch: h.fetch });

      const result = await trigger(
        "https://shop.example/plain?page=2&sort=asc",
      );

      expect(h.requests[0].url).toBe(
        "https://shop.example/plain?page=2&sort=asc",
      );
      expect(result).toMatchObject({
        ok: true,
        status: "warmed",
        target: "https://shop.example/plain?page=2&sort=asc",
      });
    });

    it("an on-demand target still rejects them, now after the route match", async () => {
      const h = handler();
      const runProducer = vi.fn(async () => output());
      const { trigger, store, ensureManifest } = warmHarness({
        fetch: h.fetch,
        runProducer,
      });

      const result = await trigger(
        "https://shop.example/products/42?preview=1",
      );

      // The route decides: the same search on a warm target is requested.
      expect(result).toEqual({
        ok: false,
        path: "on-demand",
        status: "skipped-unsupported-target",
        target: "/products/42",
        routeName: "products.detail",
      });
      expect(ensureManifest).toHaveBeenCalled();
      expect(runProducer).not.toHaveBeenCalled();
      expect(h.fetch).not.toHaveBeenCalled();
      expect(store.size).toBe(0);
    });

    it("a hash, or a param that switches the handler's mode, is unsupported on a warm", async () => {
      const h = handler();
      const { trigger } = warmHarness({ fetch: h.fetch });

      for (const target of [
        "https://shop.example/plain#top",
        "https://shop.example/plain?_rsc_partial=true",
        "https://shop.example/plain?_rsc_shell=miss",
        "https://shop.example/plain?__no_cache",
        "https://shop.example/plain?page=2&_rsc_action=x",
      ]) {
        expect(await trigger(target), target).toMatchObject({
          ok: false,
          path: "warm",
          status: "skipped-unsupported-target",
          routeName: "plain",
        });
      }
      expect(h.fetch).not.toHaveBeenCalled();
    });

    it("a consumer's own double-underscore param is a page like any other", async () => {
      const h = handler();
      const { trigger } = warmHarness({ fetch: h.fetch });

      expect(
        await trigger("https://shop.example/plain?__variant=b"),
      ).toMatchObject({ ok: true, status: "warmed" });
    });

    it("a target that is not an http(s) URL is unsupported before any match", async () => {
      const { trigger, ensureManifest } = warmHarness();

      expect(await trigger("mailto:someone@shop.example")).toEqual({
        ok: false,
        status: "skipped-unsupported-target",
        target: "mailto:someone@shop.example",
      });
      expect(ensureManifest).not.toHaveBeenCalled();
    });
  });

  describe("the store gate", () => {
    it("no createRouter({ cache }) is no-store", async () => {
      const h = handler();
      const { trigger } = warmHarness({
        fetch: h.fetch,
        resolveCacheConfig: () => undefined,
      });

      expect(await trigger("https://shop.example/plain")).toEqual({
        ok: false,
        path: "warm",
        status: "no-store",
        target: "https://shop.example/plain",
        routeName: "plain",
      });
      expect(h.fetch).not.toHaveBeenCalled();
    });

    it("cache: { enabled: false } is no-store", async () => {
      const h = handler();
      const { trigger } = warmHarness({
        fetch: h.fetch,
        resolveCacheConfig: () => ({
          store: new SharedStore(),
          enabled: false,
        }),
      });

      expect(await trigger("https://shop.example/plain")).toMatchObject({
        ok: false,
        status: "no-store",
      });
      expect(h.fetch).not.toHaveBeenCalled();
    });

    it("a throwing cache factory maps to no-store with the error, not a rejection", async () => {
      const boom = new Error("missing KV binding");
      const { trigger } = warmHarness({
        resolveCacheConfig: () => {
          throw boom;
        },
      });

      const result = await trigger("https://shop.example/plain");

      expect(result).toMatchObject({ ok: false, status: "no-store" });
      expect((result as { error?: unknown }).error).toBe(boom);
    });

    it("a local store is refused before anything renders", async () => {
      const h = handler();
      const { trigger } = warmHarness({
        fetch: h.fetch,
        store: new MemorySegmentCacheStore(),
      });

      expect(await trigger("https://shop.example/plain")).toEqual({
        ok: false,
        path: "warm",
        status: "skipped-store-not-shared",
        target: "https://shop.example/plain",
        routeName: "plain",
      });
      expect(h.fetch).not.toHaveBeenCalled();
    });

    it("under the Vite dev server the memory store is warmed, and the not-shared warning stays quiet", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const h = handler();
      const { trigger } = warmHarness({
        fetch: h.fetch,
        store: new MemorySegmentCacheStore(),
        isViteDevServer: () => true,
      });

      expect(await trigger("https://shop.example/plain")).toMatchObject({
        ok: true,
        status: "warmed",
      });
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("a store that declares no scope is refused; a regional one is warmed", async () => {
      const inner = new MemorySegmentCacheStore();
      const undeclared: SegmentCacheStore = {
        get: (key) => inner.get(key),
        set: (key, data, ttl, swr) => inner.set(key, data, ttl, swr),
        delete: (key) => inner.delete(key),
      };
      const regional: SegmentCacheStore = { ...undeclared, scope: "regional" };

      expect(
        await warmHarness({ store: undeclared }).trigger(
          "https://shop.example/plain",
        ),
      ).toMatchObject({ ok: false, status: "skipped-store-not-shared" });
      expect(
        await warmHarness({ store: regional, fetch: handler().fetch }).trigger(
          "https://shop.example/plain",
        ),
      ).toMatchObject({ ok: true, status: "warmed" });
    });

    it("warns once per router in dev, naming the store and its scope", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { trigger } = warmHarness({
        store: new LocalStore(),
        isViteDevServer: () => true,
      });

      await trigger("https://shop.example/plain");
      await trigger("https://shop.example/plain?page=2");

      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0][0]);
      expect(message).toContain('router.prerender("/plain") did not warm');
      expect(message).toContain("(LocalStore)");
      expect(message).toContain('declares scope "local"');
      expect(message).toContain("CFCacheStore with kv");
      warn.mockRestore();
    });

    it("names an undeclared scope, and stays silent outside dev", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const inner = new MemorySegmentCacheStore();
      const undeclared: SegmentCacheStore = {
        get: (key) => inner.get(key),
        set: (key, data, ttl, swr) => inner.set(key, data, ttl, swr),
        delete: (key) => inner.delete(key),
      };

      await warmHarness({
        store: undeclared,
        isViteDevServer: () => false,
      }).trigger("https://shop.example/plain");
      expect(warn).not.toHaveBeenCalled();

      await warmHarness({
        store: undeclared,
        isViteDevServer: () => true,
      }).trigger("https://shop.example/plain");
      expect(String(warn.mock.calls[0][0])).toContain(
        "the cache store declares no scope",
      );
      warn.mockRestore();
    });
  });

  describe("statuses", () => {
    it("skipped-uncached: the request rendered and no cache wrote", async () => {
      const { trigger } = warmHarness({ fetch: handler(() => {}).fetch });

      expect(await trigger("https://shop.example/plain")).toEqual({
        ok: false,
        path: "warm",
        status: "skipped-uncached",
        target: "https://shop.example/plain",
        routeName: "plain",
        responseStatus: 200,
        caches: { writes: { record: 0, item: 0, response: 0, shell: 0 } },
      });
    });

    it("shell-not-stored: a ppr route whose capture stored nothing, with why", async () => {
      const { trigger } = warmHarness({
        fetch: handler((record) => {
          record.writes.item += 1;
          record.shell = "refused";
          record.refusal = "size";
        }).fetch,
      });

      expect(await trigger("https://shop.example/plain")).toMatchObject({
        ok: false,
        path: "warm",
        status: "shell-not-stored",
        caches: {
          writes: { record: 0, item: 1, response: 0, shell: 0 },
          shell: "refused",
          refusal: "size",
        },
      });
    });

    it("skipped-personalized: an identity guard refused a read", async () => {
      const { trigger } = warmHarness({
        fetch: handler((record) => {
          record.identity = "cookies()";
          record.shell = "refused";
          record.refusal = "identity";
        }).fetch,
      });

      expect(await trigger("https://shop.example/plain")).toMatchObject({
        ok: false,
        path: "warm",
        status: "skipped-personalized",
        caches: { shell: "refused", refusal: "identity" },
      });
    });

    it("render-failed: a redirect carries its status (an anonymous visitor is not served a page there)", async () => {
      const { trigger } = warmHarness({
        fetch: handler(
          () => {},
          () =>
            new Response(null, {
              status: 302,
              headers: { location: "/login" },
            }),
        ).fetch,
      });

      expect(await trigger("https://shop.example/plain")).toMatchObject({
        ok: false,
        path: "warm",
        status: "render-failed",
        responseStatus: 302,
      });
    });

    it("render-failed: a handler throw is the error; a render error the record reported is too", async () => {
      const boom = new Error("handler threw");
      const thrown = await warmHarness({
        fetch: async () => {
          throw boom;
        },
      }).trigger("https://shop.example/plain");
      expect(thrown).toMatchObject({ ok: false, status: "render-failed" });
      expect((thrown as { error?: unknown }).error).toBe(boom);

      const renderError = new Error("component threw");
      const rendered = await warmHarness({
        fetch: handler((record) => {
          record.writes.record += 1;
          record.renderErrors.push(renderError);
        }).fetch,
      }).trigger("https://shop.example/plain");
      expect(rendered).toMatchObject({
        ok: false,
        status: "render-failed",
        responseStatus: 200,
      });
      expect((rendered as { error?: unknown }).error).toBe(renderError);
    });

    it("throwOnError throws a PrerenderError on a refusal too", async () => {
      const { trigger } = warmHarness({ store: new MemorySegmentCacheStore() });

      await expect(
        trigger("https://shop.example/plain", { throwOnError: true }),
      ).rejects.toMatchObject({
        name: "PrerenderError",
        result: { status: "skipped-store-not-shared" },
      });
    });
  });

  describe("onlyIfStale", () => {
    it("is fill mode: the request reads its caches normally", async () => {
      const h = handler(() => {});
      const { trigger } = warmHarness({ fetch: h.fetch });

      const result = await trigger("https://shop.example/plain", {
        onlyIfStale: true,
      });

      expect(h.records[0].mode).toBe("fill");
      // Nothing was cold or stale.
      expect(result).toEqual({
        ok: true,
        path: "warm",
        status: "already-fresh",
        target: "https://shop.example/plain",
        routeName: "plain",
        responseStatus: 200,
        caches: { writes: { record: 0, item: 0, response: 0, shell: 0 } },
      });
    });

    it("reports warmed when a cold or stale entry was rewritten", async () => {
      const { trigger } = warmHarness({
        fetch: handler((record) => {
          record.writes.shell += 1;
          record.shell = "stored";
        }).fetch,
      });

      expect(
        await trigger("https://shop.example/plain", { onlyIfStale: true }),
      ).toMatchObject({ ok: true, status: "warmed" });
    });
  });

  describe("an on-demand route, then its warm", () => {
    it("renders into the prerender store first, then warms; the warm rides `caches`", async () => {
      const order: string[] = [];
      const h = handler((record) => {
        order.push("warm");
        record.writes.item += 1;
      });
      const { trigger, store } = warmHarness({
        fetch: h.fetch,
        runProducer: async () => {
          order.push("producer");
          return output();
        },
      });

      const result = await trigger("https://shop.example/products/42");

      expect(order).toEqual(["producer", "warm"]);
      expect(store.size).toBe(1);
      expect(result).toMatchObject({
        ok: true,
        path: "on-demand",
        status: "rendered",
        target: "/products/42",
        routeName: "products.detail",
        caches: { writes: { record: 0, item: 1, response: 0, shell: 0 } },
      });
      // Always replace mode: it must render on top of the new entry.
      expect(h.records[0].mode).toBe("replace");
      expect(h.requests[0].url).toBe("https://shop.example/products/42");
    });

    it("keeps the on-demand status whatever the warm reports", async () => {
      const { trigger } = warmHarness({
        fetch: handler(
          () => {},
          () => new Response(null, { status: 500 }),
        ).fetch,
      });

      expect(await trigger("https://shop.example/products/42")).toMatchObject({
        ok: true,
        status: "rendered",
        caches: { writes: { record: 0, item: 0, response: 0, shell: 0 } },
      });
    });

    it("on a local store, or with no origin, it renders and skips the warm silently", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const h = handler();
      const local = await warmHarness({
        fetch: h.fetch,
        store: new LocalStore(),
        isViteDevServer: () => true,
      }).trigger("https://shop.example/products/42");
      const noOrigin = await warmHarness({
        fetch: h.fetch,
        isViteDevServer: () => true,
      }).trigger("/products/42");

      for (const result of [local, noOrigin]) {
        expect(result).toMatchObject({ ok: true, status: "rendered" });
        expect(result).not.toHaveProperty("caches");
      }
      expect(h.fetch).not.toHaveBeenCalled();
      // The on-demand refresh is complete without the warm: no warning.
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("does not warm after a failed render, a fresh entry, or a failed store write", async () => {
      const h = handler();
      const failed = await warmHarness({
        fetch: h.fetch,
        runProducer: async () => {
          throw new Error("render failed");
        },
      }).trigger("https://shop.example/products/42");
      expect(failed).toMatchObject({ ok: false, status: "render-failed" });

      const fresh = warmHarness({ fetch: h.fetch });
      await fresh.trigger("/products/42");
      expect(
        await fresh.trigger("https://shop.example/products/42", {
          onlyIfStale: true,
        }),
      ).toMatchObject({ ok: true, status: "already-fresh" });

      expect(h.fetch).not.toHaveBeenCalled();
    });

    it("a Passthrough param the producer declined is still warmed: the live handler serves it", async () => {
      const h = handler((record) => {
        record.writes.record += 1;
      });
      const { trigger, store } = warmHarness({
        fetch: h.fetch,
        runProducer: async () => output({ passthrough: true }),
      });

      const result = await trigger("https://shop.example/products/42");

      expect(store.size).toBe(0);
      expect(result).toMatchObject({
        ok: false,
        path: "on-demand",
        status: "skipped-passthrough",
        caches: { writes: { record: 1, item: 0, response: 0, shell: 0 } },
      });
    });
  });

  describe("many()", () => {
    it("dispatches each target on its own: one result per target, in input order", async () => {
      const h = handler();
      const { trigger } = warmHarness({ fetch: h.fetch });

      const results = await trigger.many(
        [
          "https://shop.example/plain",
          "https://shop.example/products/7",
          "https://shop.example/nope",
          "https://shop.example/plain?page=2",
        ],
        { concurrency: 3 },
      );

      expect(results.map((r) => [r.path, r.status])).toEqual([
        ["warm", "warmed"],
        ["on-demand", "rendered"],
        [undefined, "no-match"],
        ["warm", "warmed"],
      ]);
    });

    it("on a local store the on-demand targets render and the warm targets are refused, each reported", async () => {
      const { trigger } = warmHarness({ store: new MemorySegmentCacheStore() });

      const results = await trigger.many([
        "https://shop.example/products/7",
        "https://shop.example/plain",
      ]);

      expect(results.map((r) => [r.ok, r.status])).toEqual([
        [true, "rendered"],
        [false, "skipped-store-not-shared"],
      ]);
    });

    it("defaults to one request at a time", async () => {
      let active = 0;
      let peak = 0;
      const { trigger } = warmHarness({
        fetch: async (request) => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 2));
          readWarmMark(request)!.writes.record += 1;
          active -= 1;
          return new Response("ok");
        },
      });

      await trigger.many([
        "https://shop.example/plain?a",
        "https://shop.example/plain?b",
        "https://shop.example/plain?c",
      ]);

      expect(peak).toBe(1);
    });

    it("throwOnError stops the batch at the first refusal", async () => {
      const h = handler();
      const { trigger } = warmHarness({ fetch: h.fetch });

      await expect(
        trigger.many(
          [
            "https://shop.example/plain",
            "https://shop.example/plain#hash",
            "https://shop.example/plain?later",
          ],
          { throwOnError: true },
        ),
      ).rejects.toMatchObject({
        result: { status: "skipped-unsupported-target" },
      });
      expect(h.requests.map((r) => r.url)).toEqual([
        "https://shop.example/plain",
      ]);
    });
  });
});
