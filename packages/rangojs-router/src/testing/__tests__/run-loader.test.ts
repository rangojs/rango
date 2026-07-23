import { describe, it, expect } from "vitest";
import { runLoader, runLoaderResult } from "../run-loader.js";
import { createVar } from "../../context-var.js";
import { createHandle } from "../../handle.js";
import { getRequestContext } from "../../server/request-context.js";
import { cookies, invalidateClientCache } from "../../server/cookie-store.js";
import { redirect } from "../../route-definition/redirect.js";
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

  it("seeds ctx.use(OtherLoader) from the loaders tuples (by reference)", async () => {
    const Dep = { __brand: "loader", $$id: "x#Dep2" } as LoaderDefinition<{
      count: number;
    }>;
    const result = await runLoader(
      async (ctx) => {
        const dep = await ctx.use(Dep);
        return dep.count * 2;
      },
      { loaders: [[Dep, { count: 10 }]] },
    );
    expect(result).toBe(20);
  });

  it("loaders tuples win over the use resolver when both match", async () => {
    const Dep = { __brand: "loader", $$id: "x#Dep3" } as LoaderDefinition<{
      count: number;
    }>;
    const result = await runLoader(async (ctx) => (await ctx.use(Dep)).count, {
      loaders: [[Dep, { count: 7 }]],
      use: () => ({ count: 99 }) as any,
    });
    expect(result).toBe(7);
  });

  it("seeded ctx.use(Loader) returns a Promise (production parity, not the raw value)", async () => {
    // Production ctx.use(Loader) ALWAYS returns a Promise. A consumer composing
    // on the result (.then / Promise.race) must work the same for a seeded loader
    // as for the real-fn delegate path. Before the fix the seeded branch returned
    // the raw value, so `.then` was not a function.
    const Dep = {
      __brand: "loader",
      $$id: "x#DepThenable",
    } as LoaderDefinition<{
      count: number;
    }>;
    const result = await runLoader(
      async (ctx) => {
        const used = ctx.use(Dep);
        // The seeded result must be thenable, exactly like production.
        return used instanceof Promise && typeof used.then === "function"
          ? await used.then((d) => d.count * 2)
          : -1;
      },
      { loaders: [[Dep, { count: 5 }]] },
    );
    expect(result).toBe(10);
  });

  it("ctx.use(Loader) via the opts.use resolver also returns a Promise", async () => {
    const Dep = {
      __brand: "loader",
      $$id: "x#DepUseThenable",
    } as LoaderDefinition<{
      count: number;
    }>;
    const result = await runLoader(
      async (ctx) => {
        const used = ctx.use(Dep);
        return used instanceof Promise ? await used.then((d) => d.count) : -1;
      },
      { use: () => ({ count: 8 }) as any },
    );
    expect(result).toBe(8);
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
      const Products = createHandle<string, string[]>((s) => s.flat());
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
      const Products = createHandle<string, string[]>((s) => s.flat());
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

    it("returns [] for an UNSEEDED handle with the default collect (production parity)", async () => {
      // Post-barrier, production resolves an unseeded handle via collectHandleData
      // -> collect([]); for the default collect that is []. The testing tier must
      // not throw or leak the handle into the loader resolver.
      const Products = createHandle<string, string[]>((s) => s.flat());
      const data = await runLoader(
        async (ctx) => {
          await ctx.rendered();
          return ctx.use(Products);
        },
        { rendered: true },
      );
      expect(data).toEqual([]);
    });

    it("runs a CUSTOM collect over empty segments for an unseeded handle", async () => {
      const PageTitle = createHandle<string, string>(
        (s) => s.flat().at(-1) ?? "fallback",
      );
      const data = await runLoader(
        async (ctx) => {
          await ctx.rendered();
          return ctx.use(PageTitle);
        },
        { rendered: true },
      );
      expect(data).toBe("fallback");
    });

    it("never feeds an unseeded handle into the opts.use loader resolver", async () => {
      // opts.use is a loaders-only resolver; a handle must resolve via the
      // collect path, not silently land in opts.use as if it were a loader.
      const Products = createHandle<string, string[]>((s) => s.flat());
      let useResolverSaw: unknown;
      const data = await runLoader(
        async (ctx) => {
          await ctx.rendered();
          return ctx.use(Products);
        },
        {
          rendered: true,
          use: (loader) => {
            useResolverSaw = loader;
            return [] as any;
          },
        },
      );
      expect(useResolverSaw).toBeUndefined();
      expect(data).toEqual([]);
    });

    it("throws if ctx.use(handle) is read BEFORE await ctx.rendered() (production parity)", async () => {
      // Production gates handle reads on the render barrier
      // (loader-resolution.ts). A loader that forgets `await ctx.rendered()`
      // must fail in the test too — not silently return the seeded data — or
      // the bug (a loader that throws on the first real request) ships green.
      // This test fails on the pre-fix code (which returned the seed regardless).
      const Products = createHandle<string, string[]>((s) => s.flat());
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

describe("runLoaderResult — effect observability (cookies/headers/redirect)", () => {
  it("returns result and undefined thrown when the loader returns normally", async () => {
    const { result, thrown } = await runLoaderResult(async () => ({
      items: [1, 2, 3],
    }));
    expect(result).toEqual({ items: [1, 2, 3] });
    expect(thrown).toBeUndefined();
  });

  it("surfaces a Set-Cookie a loader set on response + cookies", async () => {
    const {
      result,
      response,
      cookies: jar,
    } = await runLoaderResult(async () => {
      cookies().set("prefs", "dark", { path: "/" });
      return { ok: true };
    });
    expect(result).toEqual({ ok: true });
    expect(jar.prefs).toBe("dark");
    expect(
      response.headers.getSetCookie().some((c) => c.startsWith("prefs=dark")),
    ).toBe(true);
  });

  it("captures an auth loader's set-cookie-then-redirect (the login pattern)", async () => {
    // The exact gap the finding documents: today runLoader only lets you check
    // the redirect, not the Set-Cookie. runLoaderResult exposes BOTH.
    const {
      result,
      thrown,
      response,
      cookies: jar,
    } = await runLoaderResult(
      async () => {
        cookies().set("session", "tok", { path: "/", httpOnly: true });
        throw redirect("/");
      },
      { request: new Request("https://app.test/login?token=ok") },
    );
    expect(result).toBeUndefined();
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).headers.get("Location")).toBe("/");
    // response merges the redirect's Location AND the accumulated Set-Cookie.
    expect(response.headers.get("Location")).toBe("/");
    expect(
      response.headers.getSetCookie().some((c) => c.startsWith("session=tok")),
    ).toBe(true);
    expect(jar.session).toBe("tok");
  });

  it("surfaces a loader's invalidateClientCache() rotation via stateCookieName", async () => {
    const { response, stateCookieName } = await runLoaderResult(async () => {
      invalidateClientCache();
      return null;
    });
    expect(stateCookieName).toBe("rango-state_router_0");
    expect(
      response.headers
        .getSetCookie()
        .some((c) => c.startsWith(stateCookieName + "=")),
    ).toBe(true);
  });

  it("preserves the full loader context (params, ctx.use seeding) on the rich path", async () => {
    const Other = createVar<{ n: number }>();
    const { result } = await runLoaderResult(
      async (ctx) => ({ id: ctx.params.id, n: ctx.get(Other)?.n }),
      { params: { id: "7" }, vars: [[Other, { n: 5 }]] },
    );
    expect(result).toEqual({ id: "7", n: 5 });
  });
});
