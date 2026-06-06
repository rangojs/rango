import { describe, it, expect } from "vitest";
import { runLoader } from "../run-loader.js";
import { createVar } from "../../context-var.js";
import { createHandle } from "../../handle.js";
import { getRequestContext } from "../../server/request-context.js";
import { registerFetchableLoader } from "../../server/fetchable-loader-store.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import type { LoaderContext, LoaderDefinition } from "../../types.js";

describe("runLoader", () => {
  it("returns the loader's resolved data", async () => {
    const data = await runLoader(async () => ({ items: [1, 2, 3] }));
    expect(data).toEqual({ items: [1, 2, 3] });
  });

  it("exposes params and routeParams", async () => {
    const result = await runLoader(
      async (ctx) => ({ id: ctx.params.id, routeId: ctx.routeParams.id }),
      { params: { id: "42" } },
    );
    expect(result).toEqual({ id: "42", routeId: "42" });
  });

  it("exposes env", async () => {
    const result = await runLoader<string>(
      async (ctx) => (ctx.env as { region: string }).region,
      { env: { region: "eu" } },
    );
    expect(result).toBe("eu");
  });

  it("surfaces search params from opts.search", async () => {
    const result = await runLoader<string | null>(
      async (ctx) => ctx.searchParams.get("q"),
      { search: { q: "shoes" } },
    );
    expect(result).toBe("shoes");
  });

  it("seeds the typed ctx.search via searchData (distinct from raw searchParams)", async () => {
    const result = await runLoader(async (ctx) => ctx.search, {
      searchData: { q: "shoes", page: 2, inStock: true },
    });
    expect(result).toEqual({ q: "shoes", page: 2, inStock: true });
  });

  it("defaults ctx.search to {} when searchData is omitted", async () => {
    const result = await runLoader(async (ctx) => ctx.search, {
      search: { q: "raw" },
    });
    expect(result).toEqual({});
  });

  it("bakes opts.search into the request URL so ctx.request.url and ctx.searchParams agree", async () => {
    const result = await runLoader(
      async (ctx) => ({
        fromRequest: new URL(ctx.request.url).searchParams.get("q"),
        fromSearchParams: ctx.searchParams.get("q"),
      }),
      { search: { q: "shoes" } },
    );
    expect(result).toEqual({ fromRequest: "shoes", fromSearchParams: "shoes" });
  });

  it("reads variables seeded via vars (string key and ContextVar)", async () => {
    const User = createVar<{ name: string }>();
    const result = await runLoader(
      async (ctx) => ({
        flag: ctx.get("flag"),
        user: ctx.get(User),
      }),
      {
        vars: [
          ["flag", true],
          [User, { name: "Ada" }],
        ],
      },
    );
    expect(result).toEqual({ flag: true, user: { name: "Ada" } });
  });

  it("resolves ctx.reverse from opts.routeMap", async () => {
    const result = await runLoader<string>(
      async (ctx) => ctx.reverse("post", { slug: "hello" }),
      { routeMap: { post: "/blog/:slug" } },
    );
    expect(result).toBe("/blog/hello");
  });

  it("delegates ctx.use to opts.use resolver when provided", async () => {
    const Dep = { __brand: "loader", $$id: "x#Dep" } as LoaderDefinition<{
      count: number;
    }>;
    const result = await runLoader(
      async (ctx) => {
        const dep = await ctx.use(Dep);
        return dep.count * 2;
      },
      {
        use: (loader) => {
          expect((loader as LoaderDefinition).$$id).toBe("x#Dep");
          return { count: 21 } as any;
        },
      },
    );
    expect(result).toBe(42);
  });

  it("delegates ctx.use to the real request-context use() (runs the dep fn)", async () => {
    // A loader definition that carries its own fn runs via the real ctx.use().
    const Dep = {
      __brand: "loader",
      $$id: "x#DepWithFn",
      fn: async (depCtx: LoaderContext<any, any>) => ({
        region: (depCtx.env as { region: string }).region,
      }),
    } as unknown as LoaderDefinition<{ region: string }>;

    const result = await runLoader(
      async (ctx) => {
        const dep = await ctx.use(Dep);
        return dep.region;
      },
      { env: { region: "us" } },
    );
    expect(result).toBe("us");
  });

  it("exposes method and body", async () => {
    const result = await runLoader(
      async (ctx) => ({ method: ctx.method, body: ctx.body }),
      { method: "POST", body: { title: "x" } },
    );
    expect(result).toEqual({ method: "POST", body: { title: "x" } });
  });

  it("throws a clear error when the loader calls ctx.rendered()", async () => {
    await expect(
      runLoader(async (ctx) => {
        await ctx.rendered();
        return null;
      }),
    ).rejects.toThrow(/rendered\(\) is not available/);
  });

  describe("rendered barrier + handle reads (rendered + handles options)", () => {
    it("mocks ctx.rendered() and seeds ctx.use(handle) by reference", async () => {
      const Products = createHandle<string>();
      const data = await runLoader(
        async (ctx) => {
          await ctx.rendered();
          const ids = ctx.use(Products) as string[];
          return { count: ids.length, first: ids[0] };
        },
        { rendered: true, handles: [[Products, ["a", "b", "c"]]] },
      );
      expect(data).toEqual({ count: 3, first: "a" });
    });

    it("accepts a function form of rendered for custom timing/side effects", async () => {
      let barrierRan = false;
      const data = await runLoader(
        async (ctx) => {
          await ctx.rendered();
          return { ok: true };
        },
        {
          rendered: () => {
            barrierRan = true;
          },
        },
      );
      expect(barrierRan).toBe(true);
      expect(data).toEqual({ ok: true });
    });

    it("still throws on ctx.rendered() when the option is not set", async () => {
      const Products = createHandle<string>();
      await expect(
        runLoader(
          async (ctx) => {
            await ctx.rendered();
            return ctx.use(Products);
          },
          { handles: [[Products, ["a"]]] },
        ),
      ).rejects.toThrow(/rendered\(\) is not available/);
    });

    it("throws if ctx.use(handle) is read BEFORE await ctx.rendered() (production parity)", async () => {
      // Production gates handle reads on the render barrier
      // (loader-resolution.ts). A loader that forgets `await ctx.rendered()`
      // must fail in the test too — not silently return the seeded data — or
      // the bug (a loader that throws on the first real request) ships green.
      // This test fails on the pre-fix code (which returned the seed regardless).
      const Products = createHandle<string>();
      await expect(
        runLoader(async (ctx) => ({ products: ctx.use(Products) }), {
          rendered: true,
          handles: [[Products, ["a", "b"]]],
        }),
      ).rejects.toThrow(/requires "await ctx\.rendered\(\)" first/);
    });
  });

  it("wires cacheStore/cacheProfiles into the request context so use cache does not bypass", async () => {
    // Without a store, registerCachedFunction bypasses BEFORE the taint/profile
    // checks (cache-runtime.ts), making a cached loader a silent no-op under
    // test. The options must reach createRequestContext._cacheStore so a real
    // cached loader can be exercised.
    const store = new MemorySegmentCacheStore();
    const result = await runLoader(
      async () => {
        const ctx = getRequestContext() as unknown as {
          _cacheStore?: unknown;
          _cacheProfiles?: Record<string, unknown>;
        };
        return {
          hasStore: ctx._cacheStore === store,
          hasProfile: Boolean(ctx._cacheProfiles?.fast),
        };
      },
      { cacheStore: store, cacheProfiles: { fast: { ttl: 60 } } },
    );
    expect(result).toEqual({ hasStore: true, hasProfile: true });
  });

  it("throws on ctx.reverse() use without a routeMap", async () => {
    await expect(
      runLoader(async (ctx) => ctx.reverse("post", { slug: "x" })),
    ).rejects.toThrow();
  });
});

describe("runLoader accepts a registered createLoader handle", () => {
  it("recovers and runs the fn from the fetchable registry by $$id", async () => {
    // What a real createLoader() does: register the fn under its $$id. (A real
    // createLoader via @rangojs/router does this with a runtime-fallback id in a
    // bare test; here we register directly to test the recovery path in isolation.)
    const id = "test/recover#L1";
    registerFetchableLoader(
      id,
      async (ctx: LoaderContext) => ({ id: ctx.params.id, who: "registry" }),
      [],
      false,
    );
    const def = {
      __brand: "loader",
      $$id: id,
    } as LoaderDefinition<{ id: string; who: string }>;

    const data = await runLoader(def, { params: { id: "42" } });
    expect(data).toEqual({ id: "42", who: "registry" });
  });

  it("runs an inline def.fn when present (no registry entry needed)", async () => {
    const def = {
      __brand: "loader",
      $$id: "test/inline#L2",
      fn: async (ctx: LoaderContext) => ({ q: ctx.searchParams.get("q") }),
    } as unknown as LoaderDefinition<{ q: string | null }>;

    const data = await runLoader(def, { search: { q: "hi" } });
    expect(data).toEqual({ q: "hi" });
  });

  it("throws a clear error when the handle's fn cannot be recovered", async () => {
    // A handle imported through the CLIENT build (body dropped) and never
    // registered: runLoader cannot recover a fn and must say so.
    const def = {
      __brand: "loader",
      $$id: "test/unrecoverable#L3",
    } as LoaderDefinition<unknown>;

    await expect(runLoader(def)).rejects.toThrow(/could not be recovered/);
  });

  it("still accepts a raw loader body (unchanged)", async () => {
    const data = await runLoader(async (ctx) => ({ m: ctx.method }));
    expect(data).toEqual({ m: "GET" });
  });
});
