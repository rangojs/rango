/**
 * "use cache" arguments through runLoader (issue #924), under the plugin-rsc
 * stubs that rangoTestAliases ships (src/testing/vitest-stubs/plugin-rsc.ts).
 * Outside the react-server condition the stub encoder and serializer throw,
 * so nothing is written and a hit is not observable here; the store lookups
 * are. use-cache-hit.rsc-test.tsx asserts hits. A Request argument
 * (ctx.request) is looked up per URL; an argument that cannot be serialized
 * runs uncached and warns once in dev.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import { runLoader, runLoaderResult } from "../run-loader.js";
import { runMiddleware } from "../run-middleware.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import { registerCachedFunction } from "../../cache/cache-runtime.js";
import { createVar } from "../../context-var.js";

function spiedStore() {
  const store = new MemorySegmentCacheStore();
  const lookups: string[] = [];
  const getItem = store.getItem.bind(store);
  store.getItem = async (key: string) => {
    lookups.push(key);
    return getItem(key);
  };
  const options = {
    cacheStore: store,
    cacheProfiles: { default: { ttl: 60 } },
  };
  return { options, lookups };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runLoader: "use cache" arguments', () => {
  it("a Request argument is looked up per URL", async () => {
    const getPage = registerCachedFunction(
      async (request: Request, path: string) =>
        `${new URL(request.url).host}${path}`,
      "userland#getPage",
      "default",
    );
    const { options, lookups } = spiedStore();
    const load = (url: string) =>
      runLoader(async (ctx) => getPage(ctx.request, "/"), {
        request: url,
        ...options,
      });

    expect(await load("https://a.example/")).toBe("a.example/");
    expect(await load("https://a.example/")).toBe("a.example/");
    expect(await load("https://b.example/")).toBe("b.example/");
    expect(lookups).toHaveLength(3);
    expect(lookups[1]).toBe(lookups[0]);
    expect(lookups[2]).not.toBe(lookups[0]);
  });

  it("an argument that cannot be serialized runs uncached and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const withCallback = registerCachedFunction(
      async (_onDone: () => void) => ++calls,
      "userland#withCallback",
      "default",
    );
    const { options, lookups } = spiedStore();
    const load = () => runLoader(async () => withCallback(() => {}), options);

    expect(await load()).toBe(1);
    expect(await load()).toBe(2);
    expect(lookups).toEqual([]);
    const warnings = warn.mock.calls
      .map((args) => String(args[0]))
      .filter((message) => message.includes("userland#withCallback"));
    expect(warnings).toHaveLength(1);
  });
});

describe('"use cache" with a loader or middleware ctx argument (#940)', () => {
  // async function getProduct(ctx) { "use cache"; ... }
  const getProduct = registerCachedFunction(
    async (ctx: { params: Record<string, string | undefined> }) =>
      `p:${ctx.params.id}`,
    "userland#940:getProduct",
    "default",
  );

  it("runLoader: the loader ctx is looked up per route, params and search", async () => {
    const { options, lookups } = spiedStore();
    const load = (id: string, search = "") =>
      runLoader(async (ctx) => getProduct(ctx), {
        request: `https://shop.example/p/${id}${search}`,
        params: { id },
        routeName: "product",
        ...options,
      });

    expect(await load("1")).toBe("p:1");
    expect(await load("1")).toBe("p:1");
    expect(await load("2")).toBe("p:2");
    expect(await load("1", "?sort=asc")).toBe("p:1");
    expect(lookups).toHaveLength(4);
    expect(lookups[1]).toBe(lookups[0]);
    expect(new Set(lookups).size).toBe(3);
  });

  it("runLoader: a loader ctx carrying a request body runs uncached", async () => {
    const { options, lookups } = spiedStore();
    const describeBody = registerCachedFunction(
      async (ctx: { body?: unknown }) => JSON.stringify(ctx.body),
      "userland#940:describeBody",
      "default",
    );
    const load = (body: unknown) =>
      runLoader(async (ctx) => describeBody(ctx), {
        method: "POST",
        body,
        params: { id: "1" },
        ...options,
      });

    expect(await load({ qty: 1 })).toBe('{"qty":1}');
    expect(await load({ qty: 2 })).toBe('{"qty":2}');
    expect(lookups).toEqual([]);
  });

  it("runMiddleware: the middleware ctx is looked up per URL", async () => {
    const { options, lookups } = spiedStore();
    const run = (id: string) =>
      runMiddleware(
        async (ctx, next) => {
          ctx.header("x-product", await getProduct(ctx));
          return next();
        },
        {
          request: `https://shop.example/p/${id}`,
          params: { id },
          ...options,
        },
      );

    expect((await run("1")).headers["x-product"]).toBe("p:1");
    expect((await run("1")).headers["x-product"]).toBe("p:1");
    expect((await run("2")).headers["x-product"]).toBe("p:2");
    expect(lookups).toHaveLength(3);
    expect(lookups[1]).toBe(lookups[0]);
    expect(lookups[2]).not.toBe(lookups[0]);
  });

  it("runLoader: a { cache: false } read through the passed ctx throws", async () => {
    const Tenant = createVar<string>({ cache: false });
    const getNav = registerCachedFunction(
      async (ctx: { get: (v: typeof Tenant) => string | undefined }) =>
        `nav:${ctx.get(Tenant)}`,
      "userland#940:getNav",
      "default",
    );
    const { options } = spiedStore();
    const { thrown } = await runLoaderResult(async (ctx) => getNav(ctx), {
      vars: [[Tenant, "a"]],
      ...options,
    });
    expect(String(thrown)).toMatch(
      /non-cacheable variable cannot be called inside a "use cache" function/,
    );
  });
});
