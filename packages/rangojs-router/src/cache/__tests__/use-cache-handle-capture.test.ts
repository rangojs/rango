/**
 * "use cache" handle pushes through the real router: a cached function that
 * receives ctx records only its OWN pushes on a miss and appends them on a
 * hit, so the handler's and loaders' pushes into the same segment survive and
 * appear once. A stale hit's background refresh writes its pushes into the
 * refreshed entry, not the live response. Pushes from a loader the function
 * reads with ctx.use are grouped by that loader and reach the page once per
 * request; a live run of the loader wins (#928).
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

// JSON stand-in for the Flight codec (plugin-rsc is a virtual module).
function pluginRscMock() {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    createTemporaryReferenceSet: () => new Set(),
    createClientTemporaryReferenceSet: () => new Set(),
    encodeReply: async (args: unknown[]) => JSON.stringify(args),
    renderToReadableStream: (value: unknown) => {
      const bytes = encoder.encode(JSON.stringify(value) ?? "null");
      return new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
    createFromReadableStream: async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      let result = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        result += decoder.decode(value, { stream: true });
      }
      return JSON.parse(result + decoder.decode());
    },
  };
}
vi.mock("@vitejs/plugin-rsc/rsc/server", pluginRscMock);
vi.mock("@vitejs/plugin-rsc/rsc/client", pluginRscMock);

import { createElement } from "react";
import { createRouter } from "../../router.js";
import { createLoader } from "../../loader.rsc.js";
import { createHandle } from "../../handle.js";
import { buildRouterTrieFromUrlpatterns } from "../../rsc/manifest-init.js";
import { MemorySegmentCacheStore } from "../memory-segment-store.js";
import { registerCachedFunction } from "../cache-runtime.js";
import { appendHandles } from "../handle-snapshot.js";
import { createHandleStore } from "../../server/handle-store.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../server/request-context.js";

const Crumbs = createHandle<unknown>(undefined, "test#UseCacheCrumbs");

// "use cache" function that receives ctx (tainted) and pushes a crumb.
const productCrumb = registerCachedFunction(
  async (ctx: any) => {
    ctx.use(Crumbs)("product");
    return "product-data";
  },
  "test#productCrumb",
  "default",
);

const slowProductCrumb = registerCachedFunction(
  async (ctx: any) => {
    ctx.use(Crumbs)("product");
    // Hold the cached body open so the DSL loader pushes during it.
    await new Promise<void>((r) => setTimeout(r, 20));
    return "product-data";
  },
  "test#slowProductCrumb",
  "default",
);

const loaderBody = vi.fn(async (ctx: any) => {
  ctx.use(Crumbs)("loader");
  return { ok: true };
});
const CrumbLoader = (createLoader as Function)(
  loaderBody,
  undefined,
  "test#UseCacheCrumbLoader",
);

const outerBody = vi.fn(async (ctx: any) => {
  ctx.use(Crumbs)("outer");
  await productCrumb(ctx);
  return "outer-data";
});
const outerCrumb = registerCachedFunction(
  outerBody,
  "test#outerCrumb",
  "default",
);

const sharedCrumb = registerCachedFunction(
  async (ctx: any) => {
    ctx.use(Crumbs)("shared");
    return "shared";
  },
  "test#sharedCrumb",
  "default",
);

let innerVersion = 0;
const innerVersioned = registerCachedFunction(
  async (ctx: any) => {
    innerVersion++;
    ctx.use(Crumbs)(`inner-v${innerVersion}`);
    return innerVersion;
  },
  "test#innerVersioned",
  "default",
);
const outerOverStale = registerCachedFunction(
  async (ctx: any) => {
    await innerVersioned(ctx);
    // Still running while the inner stale hit's background refresh pushes.
    await new Promise((r) => setTimeout(r, 20));
    return "outer";
  },
  "test#outerOverStale",
  "default",
);

let version = 0;
const versionedCrumb = registerCachedFunction(
  async (ctx: any) => {
    version++;
    ctx.use(Crumbs)(`v${version}`);
    return version;
  },
  "test#versionedCrumb",
  "default",
);

// A cached function that reads loader `Dep` via ctx.use. Dep's crumb carries
// its run count, so a live run is distinguishable from a replayed one.
function depScenario(name: string) {
  const dep = { runs: 0 };
  const Dep = (createLoader as Function)(
    async (ctx: any) => {
      dep.runs++;
      ctx.use(Crumbs)(`dep-v${dep.runs}`);
      return dep.runs;
    },
    undefined,
    `test#Dep_${name}`,
  );
  const withDep = registerCachedFunction(
    async (ctx: any) => {
      ctx.use(Crumbs)("pre");
      await ctx.use(Dep);
      ctx.use(Crumbs)("post");
      return name;
    },
    `test#withDep_${name}`,
    "default",
  );
  return { dep, Dep, withDep };
}

const depInside = depScenario("inside");
const depAfter = depScenario("after");
const depDsl = depScenario("dsl");
const depBefore = depScenario("before");
let readDepFirst = false;
const depStale = depScenario("stale");
let readDepLive = true;
const depNested = depScenario("nested");
const depShared = depScenario("sharedLP");
const outerWithDep = registerCachedFunction(
  async (ctx: any) => {
    ctx.use(Crumbs)("outer");
    await depNested.withDep(ctx);
    return "outer";
  },
  "test#outerWithDep",
  "default",
);

// A DSL loader that passes its own ctx to the cached function (#940).
function loaderCtxScenario(name: string) {
  const scenario = depScenario(name);
  const flags = { readFirst: false, readAfter: false };
  const Caller = (createLoader as Function)(
    async (ctx: any) => {
      if (flags.readFirst) await ctx.use(scenario.Dep);
      await scenario.withDep(ctx);
      if (flags.readAfter) await ctx.use(scenario.Dep);
      return name;
    },
    undefined,
    `test#Caller_${name}`,
  );
  return { ...scenario, Caller, flags };
}

const lcInside = loaderCtxScenario("lcInside");
const lcAfter = loaderCtxScenario("lcAfter");
const lcBefore = loaderCtxScenario("lcBefore");
const lcStale = loaderCtxScenario("lcStale");

// outer(handler ctx) -> Mid loader -> inner(Mid's loader ctx) -> Dep: a stale
// refresh of outer runs Mid on its own executor, where inner HITs.
const lcRefresh = (() => {
  const dep = { runs: 0 };
  const flags = { readFirst: false };
  const Dep = (createLoader as Function)(
    async (ctx: any) => {
      dep.runs++;
      ctx.use(Crumbs)(`dep-v${dep.runs}`);
      return dep.runs;
    },
    undefined,
    "test#Dep_lcRefresh",
  );
  const inner = registerCachedFunction(
    async (ctx: any) => ctx.use(Dep),
    "test#inner_lcRefresh",
    "default",
  );
  const Mid = (createLoader as Function)(
    async (ctx: any) => inner(ctx),
    undefined,
    "test#Mid_lcRefresh",
  );
  const outer = registerCachedFunction(
    async (ctx: any) => ctx.use(Mid),
    "test#outer_lcRefresh",
    "default",
  );
  return { dep, Dep, outer, flags };
})();

let router: any;
let cacheStore: MemorySegmentCacheStore;

beforeAll(async () => {
  cacheStore = new MemorySegmentCacheStore();
  router = createRouter({} as any);
  router.routes(({ path, loader, layout }: any) => [
    layout(
      async (ctx: any) => {
        await sharedCrumb(ctx);
        return createElement("div", null, "shared-layout");
      },
      () => [
        path(
          "/shared",
          async (ctx: any) => {
            await sharedCrumb(ctx);
            return createElement("div", null, "shared-page");
          },
          { name: "ucShared" },
        ),
      ],
    ),
    path(
      "/before",
      async (ctx: any) => {
        ctx.use(Crumbs)("home");
        await productCrumb(ctx);
        return createElement("div", null, "before");
      },
      { name: "ucBefore" },
    ),
    path(
      "/nested",
      async (ctx: any) => {
        ctx.use(Crumbs)("home");
        await outerCrumb(ctx);
        return createElement("div", null, "nested");
      },
      { name: "ucNested" },
    ),
    path(
      "/outer-stale",
      async (ctx: any) => {
        ctx.use(Crumbs)("home");
        await outerOverStale(ctx);
        return createElement("div", null, "outer-stale");
      },
      { name: "ucOuterStale" },
    ),
    path(
      "/stale",
      async (ctx: any) => {
        ctx.use(Crumbs)("home");
        await versionedCrumb(ctx);
        return createElement("div", null, "stale");
      },
      { name: "ucStale" },
    ),
    path(
      "/concurrent",
      async (ctx: any) => {
        await slowProductCrumb(ctx);
        return createElement("div", null, "concurrent");
      },
      { name: "ucConcurrent" },
      () => [loader(CrumbLoader)],
    ),
    path(
      "/dep-inside",
      async (ctx: any) => {
        ctx.use(Crumbs)("home");
        await depInside.withDep(ctx);
        return createElement("div", null, "dep-inside");
      },
      { name: "ucDepInside" },
    ),
    path(
      "/dep-after",
      async (ctx: any) => {
        await depAfter.withDep(ctx);
        await ctx.use(depAfter.Dep);
        return createElement("div", null, "dep-after");
      },
      { name: "ucDepAfter" },
    ),
    layout(
      async (ctx: any) => {
        await depDsl.withDep(ctx);
        return createElement("div", null, "dep-dsl-layout");
      },
      () => [
        path(
          "/dep-dsl",
          () => createElement("div", null, "dep-dsl"),
          {
            name: "ucDepDsl",
          },
          () => [loader(depDsl.Dep)],
        ),
      ],
    ),
    path(
      "/dep-before",
      async (ctx: any) => {
        if (readDepFirst) await ctx.use(depBefore.Dep);
        await depBefore.withDep(ctx);
        return createElement("div", null, "dep-before");
      },
      { name: "ucDepBefore" },
    ),
    path(
      "/dep-stale",
      async (ctx: any) => {
        await depStale.withDep(ctx);
        if (readDepLive) await ctx.use(depStale.Dep);
        return createElement("div", null, "dep-stale");
      },
      { name: "ucDepStale" },
    ),
    layout(
      async (ctx: any) => {
        await depShared.withDep(ctx);
        return createElement("div", null, "l");
      },
      () => [
        path(
          "/dep-shared-lp",
          async (ctx: any) => {
            await depShared.withDep(ctx);
            return createElement("div", null, "p");
          },
          { name: "ucDepSharedLP" },
        ),
      ],
    ),
    path(
      "/dep-nested",
      async (ctx: any) => {
        await outerWithDep(ctx);
        await ctx.use(depNested.Dep);
        return createElement("div", null, "dep-nested");
      },
      { name: "ucDepNested" },
    ),
    ...[lcInside, lcAfter, lcBefore, lcStale].map((s) =>
      path(
        `/${s.Caller.$$id.split("_")[1]}`,
        () => createElement("div", null, "loader-ctx"),
        { name: `uc_${s.Caller.$$id.split("_")[1]}` },
        () => [loader(s.Caller)],
      ),
    ),
    path(
      "/lcRefresh",
      async (ctx: any) => {
        if (lcRefresh.flags.readFirst) await ctx.use(lcRefresh.Dep);
        await lcRefresh.outer(ctx);
        return createElement("div", null, "lc-refresh");
      },
      { name: "uc_lcRefresh" },
    ),
  ]);
  await buildRouterTrieFromUrlpatterns(router);
});

async function serve(pathname: string, errors?: unknown[]): Promise<unknown[]> {
  return Object.values(await serveBySegment(pathname, errors)).flat();
}

async function serveBySegment(
  pathname: string,
  errors?: unknown[],
): Promise<Record<string, unknown[]>> {
  const request = new Request(`https://example.com${pathname}`, {
    headers: { accept: "text/html" },
  });
  const reqCtx = createRequestContext({
    env: {},
    request,
    url: new URL(request.url),
    variables: {},
  } as any) as RequestContext<any>;
  (reqCtx as any)._cacheStore = cacheStore;
  (reqCtx as any)._cacheProfiles = { default: { ttl: 60, swr: 60 } };
  if (errors) {
    (reqCtx as any)._reportBackgroundError = (e: unknown) => errors.push(e);
  }
  await runWithRequestContext(reqCtx, async () => {
    await router.match(request, { env: {} });
    reqCtx._handleStore.seal();
    await reqCtx._handleStore.fullySettled;
    const tasks = reqCtx._pendingBackgroundTasks ?? [];
    for (let i = 0; i < tasks.length; i++) await tasks[i];
  });
  const data = await reqCtx._handleStore.getData();
  return data[Crumbs.$$id] ?? {};
}

describe('"use cache" handle capture', () => {
  it("stale hit: the refreshed entry carries the revalidation's pushes, the live response has each push once", async () => {
    const errors: unknown[] = [];
    const miss = await serve("/stale");
    expect(miss).toEqual(["home", "v1"]);

    // Next read is stale: serve v1, revalidate in the background.
    const getItem = cacheStore.getItem;
    cacheStore.getItem = async (key: string) => {
      const hit = await getItem.call(cacheStore, key);
      return hit && key.includes("versionedCrumb")
        ? { ...hit, shouldRevalidate: true }
        : hit;
    };
    const stale = await serve("/stale", errors);
    cacheStore.getItem = getItem;
    expect(version).toBe(2);
    expect(stale).toEqual(["home", "v1"]);
    expect(errors).toEqual([]);

    const hit = await serve("/stale");
    expect(version).toBe(2);
    expect(hit).toEqual(["home", "v2"]);
  });

  it("an outer cached function does not record an inner stale hit's background refresh", async () => {
    await serve("/outer-stale");

    // Outer misses, inner is stale: the inner replays inner-v1 (recorded by
    // the outer) and refreshes to inner-v2 in the background while the outer
    // body is still running.
    const getItem = cacheStore.getItem;
    cacheStore.getItem = async (key: string) => {
      if (key.includes("outerOverStale")) return null;
      const hit = await getItem.call(cacheStore, key);
      return hit && key.includes("innerVersioned")
        ? { ...hit, shouldRevalidate: true }
        : hit;
    };
    const rebuilt = await serve("/outer-stale");
    cacheStore.getItem = getItem;
    expect(innerVersion).toBe(2);
    expect(rebuilt).toEqual(["home", "inner-v1"]);

    // The rebuilt outer entry replays what its body saw, not the refresh.
    const hit = await serve("/outer-stale");
    expect(hit).toEqual(["home", "inner-v1"]);
  });

  it("replays into the calling segment when a layout and its page call the same function", async () => {
    const miss = await serveBySegment("/shared");
    const hit = await serveBySegment("/shared");
    // One copy per calling segment (two segments), on the miss and the hit.
    expect(Object.values(miss)).toEqual([["shared"], ["shared"]]);
    expect(hit).toEqual(miss);
  });

  it("a handler push made before the cached call survives the HIT", async () => {
    const miss = await serve("/before");
    const hit = await serve("/before");
    expect(miss).toEqual(["home", "product"]);
    expect(hit).toEqual(["home", "product"]);
  });

  it("a DSL loader push made while the cached body runs appears once on the HIT", async () => {
    const miss = await serve("/concurrent");
    const hit = await serve("/concurrent");
    expect(loaderBody).toHaveBeenCalledTimes(2);
    expect(miss.filter((v) => v === "loader")).toHaveLength(1);
    expect(hit.filter((v) => v === "loader")).toHaveLength(1);
    expect(hit.filter((v) => v === "product")).toHaveLength(1);
  });

  it("an outer cached function records the pushes of cached functions it calls", async () => {
    const miss = await serve("/nested");
    const hit = await serve("/nested");
    expect(outerBody).toHaveBeenCalledTimes(1);
    expect(miss).toEqual(["home", "outer", "product"]);
    expect(hit).toEqual(["home", "outer", "product"]);
  });
});

/** Force the next read of `fnId`'s entry to `mode` while `run` serves. */
async function withEntry<T>(
  fnId: string,
  mode: "stale" | "miss",
  run: () => Promise<T>,
): Promise<T> {
  const getItem = cacheStore.getItem;
  cacheStore.getItem = async (key: string) => {
    if (!key.includes(fnId)) return getItem.call(cacheStore, key);
    if (mode === "miss") return null;
    const hit = await getItem.call(cacheStore, key);
    return hit ? { ...hit, shouldRevalidate: true } : hit;
  };
  try {
    return await run();
  } finally {
    cacheStore.getItem = getItem;
  }
}

describe('"use cache" reading a loader that is also read live (#928)', () => {
  it("a loader read only inside the cached function is replayed once on a HIT", async () => {
    const miss = await serve("/dep-inside");
    const hit = await serve("/dep-inside");
    expect(depInside.dep.runs).toBe(1);
    expect(miss).toEqual(["home", "pre", "dep-v1", "post"]);
    expect(hit).toEqual(["home", "pre", "dep-v1", "post"]);
  });

  it("HIT, handler reads the loader after the replay: the live push replaces the replayed one", async () => {
    const miss = await serve("/dep-after");
    expect(miss).toEqual(["pre", "dep-v1", "post"]);
    const hit = await serve("/dep-after");
    expect(depAfter.dep.runs).toBe(2);
    expect(hit).toEqual(["pre", "dep-v2", "post"]);
  });

  it("HIT, a DSL loader reads the loader after the replay: the live push lands once in its own segment", async () => {
    const miss = await serveBySegment("/dep-dsl");
    expect(Object.values(miss)).toEqual([["pre", "dep-v1", "post"]]);
    const hit = await serveBySegment("/dep-dsl");
    expect(depDsl.dep.runs).toBe(2);
    expect(Object.values(hit)).toEqual([["pre", "post"], ["dep-v2"]]);
  });

  it("HIT, the loader already ran live before the replay: the replay skips its pushes", async () => {
    readDepFirst = false;
    const miss = await serve("/dep-before");
    expect(miss).toEqual(["pre", "dep-v1", "post"]);
    readDepFirst = true;
    const hit = await serve("/dep-before");
    readDepFirst = false;
    expect(depBefore.dep.runs).toBe(2);
    expect(hit).toEqual(["dep-v2", "pre", "post"]);
  });

  it("stale HIT: the live run wins, and the refresh records its own run of the loader", async () => {
    const errors: unknown[] = [];
    const miss = await serve("/dep-stale");
    expect(miss).toEqual(["pre", "dep-v1", "post"]);

    const stale = await withEntry("withDep_stale", "stale", () =>
      serve("/dep-stale", errors),
    );
    expect(errors).toEqual([]);
    // The refresh and the live read each run the loader.
    expect(depStale.dep.runs).toBe(3);
    expect(stale).toHaveLength(3);
    expect(["dep-v2", "dep-v3"]).toContain(stale[1]);
    expect(stale).toEqual(["pre", stale[1], "post"]);

    // The refreshed entry replays the refresh's run, not the live one.
    readDepLive = false;
    const hit = await serve("/dep-stale");
    readDepLive = true;
    expect(depStale.dep.runs).toBe(3);
    const refreshed = stale[1] === "dep-v2" ? "dep-v3" : "dep-v2";
    expect(hit).toEqual(["pre", refreshed, "post"]);
  });

  it("a layout and its page calling the function each keep their own pushes; the loader's push lands once", async () => {
    const miss = await serveBySegment("/dep-shared-lp");
    const hit = await serveBySegment("/dep-shared-lp");
    expect(depShared.dep.runs).toBe(1);
    const once = [
      ["pre", "dep-v1", "post"],
      ["pre", "post"],
    ];
    expect(Object.values(miss)).toEqual(once);
    expect(Object.values(hit)).toEqual(once);
  });

  it("an outer cached function records an inner HIT's replayed loader pushes under that loader", async () => {
    const miss = await serve("/dep-nested");
    expect(miss).toEqual(["outer", "pre", "dep-v1", "post"]);

    // Outer misses, inner hits: the inner replays dep-v1, the live read
    // replaces it, and the outer entry records the replay as Dep's.
    const rebuilt = await withEntry("outerWithDep", "miss", () =>
      serve("/dep-nested"),
    );
    expect(rebuilt).toEqual(["outer", "pre", "dep-v2", "post"]);

    const hit = await serve("/dep-nested");
    expect(depNested.dep.runs).toBe(3);
    expect(hit).toEqual(["outer", "pre", "dep-v3", "post"]);

    // Outer stale: the page's replay claims Dep; the refresh's inner HIT
    // still records Dep's group into the refreshed outer entry.
    const stale = await withEntry("outerWithDep", "stale", () =>
      serve("/dep-nested"),
    );
    expect(stale).toEqual(["outer", "pre", "dep-v4", "post"]);
    const refreshed = await serve("/dep-nested");
    expect(depNested.dep.runs).toBe(5);
    expect(refreshed).toEqual(["outer", "pre", "dep-v5", "post"]);
  });
});

describe('"use cache" called with a loader ctx (#940)', () => {
  it("the function's pushes and a loader it reads replay once, in the calling loader's segment", async () => {
    const miss = await serveBySegment("/lcInside");
    const hit = await serveBySegment("/lcInside");
    expect(lcInside.dep.runs).toBe(1);
    expect(Object.values(miss)).toEqual([["pre", "dep-v1", "post"]]);
    expect(hit).toEqual(miss);
  });

  it("HIT, the calling loader reads the loader after the replay: the live push replaces the replayed one", async () => {
    const miss = await serve("/lcAfter");
    expect(miss).toEqual(["pre", "dep-v1", "post"]);
    lcAfter.flags.readAfter = true;
    const hit = await serve("/lcAfter");
    lcAfter.flags.readAfter = false;
    expect(lcAfter.dep.runs).toBe(2);
    expect(hit).toEqual(["pre", "dep-v2", "post"]);
  });

  it("HIT, the loader already ran live before the replay: the replay skips its pushes", async () => {
    const miss = await serve("/lcBefore");
    expect(miss).toEqual(["pre", "dep-v1", "post"]);
    lcBefore.flags.readFirst = true;
    const hit = await serve("/lcBefore");
    lcBefore.flags.readFirst = false;
    expect(lcBefore.dep.runs).toBe(2);
    expect(hit).toEqual(["dep-v2", "pre", "post"]);
  });

  it("stale HIT: the live run wins, and the refresh runs the loader on its own", async () => {
    const errors: unknown[] = [];
    const miss = await serve("/lcStale");
    expect(miss).toEqual(["pre", "dep-v1", "post"]);

    lcStale.flags.readAfter = true;
    const stale = await withEntry("withDep_lcStale", "stale", () =>
      serve("/lcStale", errors),
    );
    lcStale.flags.readAfter = false;
    expect(errors).toEqual([]);
    expect(lcStale.dep.runs).toBe(3);
    expect(["dep-v2", "dep-v3"]).toContain(stale[1]);
    expect(stale).toEqual(["pre", stale[1], "post"]);
  });

  it("an inner HIT inside an outer stale refresh records the loader's group without claiming it", async () => {
    const miss = await serve("/lcRefresh");
    expect(miss).toEqual(["dep-v1"]);

    // Dep runs live first, so a claim from the refresh would return false.
    lcRefresh.flags.readFirst = true;
    const stale = await withEntry("outer_lcRefresh", "stale", () =>
      serve("/lcRefresh"),
    );
    lcRefresh.flags.readFirst = false;
    expect(stale).toEqual(["dep-v2"]);

    const hit = await serve("/lcRefresh");
    expect(lcRefresh.dep.runs).toBe(2);
    expect(hit).toEqual(["dep-v1"]);
  });
});

describe("appendHandles record formats", () => {
  const H = "test#H";

  it("replays a segment-keyed record (written before owner keys) in full, without claiming", () => {
    const store = createHandleStore();
    const claim = vi.fn(() => false);
    appendHandles({ M0R1: { [H]: ["a", "b"] } }, store, "caller", claim);
    appendHandles({ M0R1: { [H]: ["c"] } }, store);
    expect(claim).not.toHaveBeenCalled();
    expect(store.getDataForSegment("caller")[H]).toEqual(["a", "b"]);
    expect(store.getDataForSegment("M0R1")[H]).toEqual(["c"]);
  });

  it("claims each loader once, keeps own groups, and keeps push order across groups", () => {
    const record = {
      "1:": { [H]: ["pre"] },
      "2:dep#A": { [H]: ["a1"] },
      "3:": { [H]: ["mid"] },
      "4:dep#A": { [H]: ["a2"] },
      "5:dep#B": { [H]: ["b"] },
      "6:": { [H]: ["post"] },
    };
    const store = createHandleStore();
    const claim = vi.fn((loaderId: string) => loaderId === "dep#A");
    appendHandles(record, store, "caller", claim);
    expect(claim.mock.calls).toEqual([["dep#A"], ["dep#B"]]);
    expect(store.getDataForSegment("caller")[H]).toEqual([
      "pre",
      "a1",
      "mid",
      "a2",
      "post",
    ]);
  });
});
