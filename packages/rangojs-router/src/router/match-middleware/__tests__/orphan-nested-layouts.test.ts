/**
 * Layouts nested under a routeless entry render, and a cache() declared with
 * them caches what its scope covers (issue #918).
 *
 * A bare cache() in a layout's children is registered twice: as a routeless
 * wrapper in the layout's layout[] (so the siblings after it wrap every route
 * of the layout) and as the chain parent of the routes after it. Before the
 * fix, resolveOrphanLayout rendered one orphan level only, so a layout after
 * the marker was dropped on the routes outside the marker's scope; and a
 * marker in the matched chain was also resolved as its layout's orphan, so a
 * parallel after it ran twice on a MISS and once, discarded, on a HIT, and a
 * middleware after it ran twice.
 *
 * A cache() inside a routeless layout in a path configures the path, like a
 * cache() among the path's own children (#912). Before, it cached nothing.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// JSON stand-in for the Flight codec (plugin-rsc is a virtual module).
function pluginRscMock() {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    createTemporaryReferenceSet: () => new Set(),
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
import { createRouter } from "../../../router.js";
import { buildRouterTrieFromUrlpatterns } from "../../../rsc/manifest-init.js";
import { MemorySegmentCacheStore } from "../../../cache/memory-segment-store.js";
import type { CachedEntryData } from "../../../cache/types.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../../server/request-context.js";

const calls: Record<string, number> = {};
function run(label: string): number {
  calls[label] = (calls[label] ?? 0) + 1;
  return calls[label];
}
function view(label: string) {
  return () => createElement("div", null, `${label}-${run(label)}`);
}

let headerWriteThrew: boolean | undefined;
let router: any;
let store: MemorySegmentCacheStore;
const writes = new Map<string, string[]>();
let reads = 0;

async function markerMiddleware(_ctx: unknown, next: () => Promise<void>) {
  run("mw");
  await next();
}

async function accountMiddleware(_ctx: unknown, next: () => Promise<void>) {
  await next();
}

beforeAll(async () => {
  store = new MemorySegmentCacheStore();
  const set = store.set.bind(store);
  store.set = async (
    key: string,
    data: CachedEntryData,
    ttl: number,
    swr?: number,
  ) => {
    writes.set(
      key,
      data.segments.map((s) => s.metadata.id),
    );
    return set(key, data, ttl, swr);
  };
  const get = store.get.bind(store);
  store.get = async (key: string) => {
    reads++;
    return get(key);
  };
  router = createRouter({} as any);
  router.routes(
    ({ path, cache, layout, middleware, parallel, transition }: any) => [
      path("/o/elsewhere", view("elsewhere"), { name: "oElsewhere" }),
      // The issue's form: the marker and the layout after it, no route after.
      layout(view("endShell"), () => [
        path("/o/end", view("endPage"), { name: "oEnd" }),
        cache({ ttl: 60, store }),
        layout(view("endPromo")),
      ]),
      // Routes on both sides of the marker.
      layout(view("shell"), () => [
        path("/o/before", view("beforePage"), { name: "oBefore" }),
        cache({ ttl: 60, store }),
        middleware(markerMiddleware),
        layout(view("promo")),
        parallel({ "@side": view("side") }),
        path("/o/after", view("afterPage"), { name: "oAfter" }),
      ]),
      // Marker and layout first.
      layout(view("firstShell"), () => [
        cache({ ttl: 60, store }),
        layout(view("firstPromo")),
        path("/o/first", view("firstPage"), { name: "oFirst" }),
      ]),
      // Layouts inside routeless wrappers.
      layout(view("wrapShell"), () => [
        path("/o/wrapped", view("wrappedPage"), { name: "oWrapped" }),
        cache({ ttl: 60, store }, () => [layout(view("cacheWrapped"))]),
        transition({}, () => [layout(view("txWrapped"))]),
      ]),
      // The flat form of a middleware() wrapper around a routeless layout,
      // which throws at definition time.
      path("/o/account", view("account"), { name: "oAccount" }, () => [
        middleware(accountMiddleware),
        layout(view("accountNav")),
      ]),
      // A cache() inside a routeless layout in a path.
      layout(view("productShell"), () => [
        path("/o/product", view("product"), { name: "oProduct" }, () => [
          layout(view("chrome"), () => [cache({ ttl: 300, store })]),
        ]),
        path(
          "/o/product-guard",
          (ctx: any) => {
            try {
              ctx.headers.set("x-guard", "1");
              headerWriteThrew = false;
            } catch {
              headerWriteThrew = true;
            }
            return createElement("div", null, "guard");
          },
          { name: "oProductGuard" },
          () => [
            layout(view("guardChrome"), () => [cache({ ttl: 300, store })]),
          ],
        ),
      ]),
    ],
  );
  await buildRouterTrieFromUrlpatterns(router);
});

beforeEach(async () => {
  await store.clear();
  writes.clear();
  reads = 0;
});

type Served = {
  middleware: string[];
  segments: Array<{ id: string; type: string; text: unknown }>;
};

async function serve(
  pathname: string,
  partial?: { from: string; clientSegments: string[] },
): Promise<Served> {
  const request = partial
    ? new Request(
        `https://example.com${pathname}?_rsc_partial&_rsc_segments=${partial.clientSegments.join(",")}`,
        {
          headers: {
            accept: "text/x-component",
            "X-RSC-Router-Client-Path": `https://example.com${partial.from}`,
          },
        },
      )
    : new Request(`https://example.com${pathname}`, {
        headers: { accept: "text/html" },
      });
  const reqCtx = createRequestContext({
    env: {},
    request,
    url: new URL(request.url),
    variables: {},
  } as any) as RequestContext<any>;
  let segments: any[] = [];
  let middleware: string[] = [];
  await runWithRequestContext(reqCtx, async () => {
    const preview = await router.previewMatch(request, { env: {} });
    middleware = (preview?.routeMiddleware ?? []).map(
      (m: { handler: Function }) => m.handler.name,
    );
    const result = partial
      ? await router.matchPartial(request, { env: {} })
      : await router.match(request, { env: {} });
    segments = result.segments;
    reqCtx._handleStore.seal();
    await reqCtx._handleStore.fullySettled;
    for (const cb of reqCtx._onResponseCallbacks.splice(0)) {
      cb(new Response(null, { status: 200 }));
    }
    const tasks = reqCtx._pendingBackgroundTasks!;
    for (let i = 0; i < tasks.length; i++) await tasks[i];
  });
  return {
    middleware,
    segments: segments
      .filter((s) => s.type !== "loader")
      .map((s) => ({
        id: s.id,
        type: s.type,
        text: s.component?.props?.children ?? null,
      })),
  };
}

function find(served: Served, label: string) {
  return served.segments.find(
    (s) => typeof s.text === "string" && s.text.startsWith(`${label}-`),
  );
}

describe("a layout after a bare cache() in a layout's children", () => {
  it("renders on a route before the marker when no route follows it", async () => {
    const first = await serve("/o/end");
    expect(find(first, "endPromo")?.text).toBe(`endPromo-${calls.endPromo}`);
    // It wraps the route: the promo segment sits between the shell and the page.
    const ids = first.segments.map((s) => s.id);
    expect(ids.indexOf(find(first, "endPromo")!.id)).toBeGreaterThan(
      ids.indexOf(find(first, "endShell")!.id),
    );
    expect(ids.indexOf(find(first, "endPromo")!.id)).toBeLessThan(
      ids.indexOf(find(first, "endPage")!.id),
    );
    // The route is outside the marker's scope: no store I/O, rendered live.
    const again = await serve("/o/end");
    expect(find(again, "endPromo")?.text).toBe(`endPromo-${calls.endPromo}`);
    expect(reads).toBe(0);
    expect(writes.size).toBe(0);
  });

  it("renders live on a route before the marker when routes follow it", async () => {
    const first = await serve("/o/before");
    expect(find(first, "promo")?.text).toBe(`promo-${calls.promo}`);
    const again = await serve("/o/before");
    expect(find(again, "promo")?.text).toBe(`promo-${calls.promo}`);
    expect(reads).toBe(0);
    expect(writes.size).toBe(0);
  });

  it("is cached on a route after the marker: stored, replayed on a document HIT, the shell above stays live", async () => {
    const before = { ...calls };
    const miss = await serve("/o/after");
    // Each handler inside the marker's scope ran once on the MISS.
    expect(calls.promo).toBe((before.promo ?? 0) + 1);
    expect(calls.side).toBe((before.side ?? 0) + 1);
    expect(calls.afterPage).toBe((before.afterPage ?? 0) + 1);

    const stored = [...writes.values()][0]!;
    expect(writes.size).toBe(1);
    expect(stored).toContain(find(miss, "promo")!.id);
    expect(stored).toContain(find(miss, "side")!.id);
    expect(stored).toContain(find(miss, "afterPage")!.id);
    expect(stored).not.toContain(find(miss, "shell")!.id);

    const afterMiss = { ...calls };
    const hit = await serve("/o/after");
    expect(calls.promo).toBe(afterMiss.promo);
    expect(calls.side).toBe(afterMiss.side);
    expect(calls.afterPage).toBe(afterMiss.afterPage);
    expect(find(hit, "promo")?.text).toBe(find(miss, "promo")?.text);
    expect(calls.shell).toBe(afterMiss.shell! + 1);
    expect(find(hit, "shell")?.text).toBe(`shell-${calls.shell}`);
    expect(hit.segments.map((s) => s.id)).toEqual(
      miss.segments.map((s) => s.id),
    );
  });

  it("is replayed on a partial HIT while the shell the client lacks renders fresh", async () => {
    const elsewhere = await serve("/o/elsewhere");
    const clientSegments = elsewhere.segments
      .filter((s) => s.type === "layout")
      .map((s) => s.id);
    const nav = { from: "/o/elsewhere", clientSegments };

    const miss = await serve("/o/after", nav);
    expect(find(miss, "promo")).toBeDefined();
    const afterMiss = { ...calls };
    const hit = await serve("/o/after", nav);

    expect(calls.promo).toBe(afterMiss.promo);
    expect(calls.afterPage).toBe(afterMiss.afterPage);
    expect(find(hit, "promo")?.text).toBe(find(miss, "promo")?.text);
    expect(calls.shell).toBe(afterMiss.shell! + 1);
    expect(find(hit, "shell")?.text).toBe(`shell-${calls.shell}`);
  });

  it("runs a middleware declared after the marker once per request", async () => {
    expect((await serve("/o/after")).middleware).toEqual(["markerMiddleware"]);
    expect((await serve("/o/before")).middleware).toEqual(["markerMiddleware"]);
  });

  it("renders a layout inside a routeless cache() or transition() wrapper", async () => {
    const served = await serve("/o/wrapped");
    const ids = served.segments.map((s) => s.id);
    const at = (label: string) => ids.indexOf(find(served, label)!.id);
    expect(at("cacheWrapped")).toBeGreaterThan(at("wrapShell"));
    expect(at("txWrapped")).toBeGreaterThan(at("cacheWrapped"));
    expect(at("wrappedPage")).toBeGreaterThan(at("txWrapped"));
    expect(reads).toBe(0);
    expect(writes.size).toBe(0);
  });

  it("caches a layout declared after a leading marker the same way", async () => {
    const miss = await serve("/o/first");
    expect(find(miss, "firstPromo")).toBeDefined();
    expect([...writes.values()][0]).toContain(find(miss, "firstPromo")!.id);
    const afterMiss = { ...calls };
    const hit = await serve("/o/first");
    expect(calls.firstPromo).toBe(afterMiss.firstPromo);
    expect(calls.firstShell).toBe(afterMiss.firstShell! + 1);
    expect(find(hit, "firstPromo")?.text).toBe(find(miss, "firstPromo")?.text);
  });
});

describe("middleware() and layout() listed flat in a path", () => {
  it("renders the layout and runs the middleware for the path", async () => {
    const served = await serve("/o/account");
    expect(served.middleware).toEqual(["accountMiddleware"]);
    const ids = served.segments.map((s) => s.id);
    expect(ids.indexOf(find(served, "accountNav")!.id)).toBeLessThan(
      ids.indexOf(find(served, "account")!.id),
    );
  });
});

describe("a cache() inside a routeless layout in a path", () => {
  it("caches the path: the page and the layout replay on a HIT, the layout above stays live", async () => {
    const miss = await serve("/o/product");
    expect(find(miss, "chrome")).toBeDefined();
    const stored = [...writes.values()][0]!;
    expect(writes.size).toBe(1);
    expect(stored).toContain(find(miss, "product")!.id);
    expect(stored).toContain(find(miss, "chrome")!.id);
    expect(stored).not.toContain(find(miss, "productShell")!.id);

    const afterMiss = { ...calls };
    const hit = await serve("/o/product");
    expect(calls.product).toBe(afterMiss.product);
    expect(calls.chrome).toBe(afterMiss.chrome);
    expect(find(hit, "product")?.text).toBe(find(miss, "product")?.text);
    expect(calls.productShell).toBe(afterMiss.productShell! + 1);
  });

  it("guards the path's handler like any handler inside a cache() boundary", async () => {
    headerWriteThrew = undefined;
    await serve("/o/product-guard");
    expect(headerWriteThrew).toBe(true);
  });
});
