import { describe, it, expect } from "vitest";
import { runLoader } from "../run-loader.js";
import { createVar } from "../../context-var.js";
import { createHandle } from "../../handle.js";
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
  });

  it("throws on ctx.reverse() use without a routeMap", async () => {
    await expect(
      runLoader(async (ctx) => ctx.reverse("post", { slug: "x" })),
    ).rejects.toThrow();
  });
});
