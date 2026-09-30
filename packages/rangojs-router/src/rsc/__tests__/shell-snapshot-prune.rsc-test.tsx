/**
 * PPR shell snapshot pruning (issue #941) through the real serve pipeline and
 * real Flight: a MISS schedules the capture, the capture records and prunes,
 * and a later request is served as a document HIT (or a partial replay) from
 * the stored entry. Only the SSR half is stubbed: captureShellHTML returns a
 * fixed prelude and resumeShellHTML passes the tail's Flight stream through,
 * so a HIT body is the prelude followed by the tail's Flight payload bytes.
 *
 * Every "use cache" value carries its source generation
 * (fixtures/shell-prune-data.tsx). The tests move the source on after the
 * capture and drop the store's item records, so a tail that reads an item
 * live renders a newer generation than the capture pinned.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../../testing/vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../../testing/vitest-stubs/plugin-rsc.js"),
);
vi.mock("../../prerender/store.js", () => ({
  createPrerenderStore: () => ({ get: async () => null }),
}));

// The unpruned snapshot a capture computed, for the byte-parity comparison.
const pruneInputs = vi.hoisted(() => [] as unknown[][]);
vi.mock("../../cache/shell-snapshot.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../cache/shell-snapshot.js")>();
  return {
    ...actual,
    pruneShellSnapshot: ((snapshot, readers, loaderKeys, docKey) => {
      pruneInputs.push([...snapshot]);
      return actual.pruneShellSnapshot(snapshot, readers, loaderKeys, docKey);
    }) satisfies typeof actual.pruneShellSnapshot,
  };
});

import { renderToReadableStream } from "../../testing/vitest-stubs/plugin-rsc.js";
import { createRouter } from "../../router.js";
import { createLoader } from "../../loader.rsc.js";
import { buildRouterTrieFromUrlpatterns } from "../manifest-init.js";
import { handleRscRendering } from "../rsc-rendering.js";
import { shellReloadScript } from "../shell-serve.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import type {
  CacheItemOptions,
  CacheItemResult,
  ShellCacheEntry,
  ShellSnapshotRecord,
} from "../../cache/types.js";
import {
  createRequestContext,
  runWithRequestContext,
  setRequestContextParams,
  type RequestContext,
} from "../../server/request-context.js";
import {
  classifyRequest,
  type ClassifyRequestDeps,
} from "../../router/request-classification.js";
import type { HandlerContext } from "../handler-context.js";
import type { RscPayload, SSRModule } from "../types.js";
import type { PartialCacheOptions } from "../../types.js";
import {
  getCatalog,
  getStamp,
  renderCatalog,
  renderChrome,
  source,
} from "./fixtures/shell-prune-data.js";

const PRELUDE = "<html><body>FROZEN-PRELUDE</body></html>";

/**
 * A memory store whose item family the test can drop and observe. Segment and
 * shell families are the real MemorySegmentCacheStore's.
 */
function makeStore(): {
  store: MemorySegmentCacheStore;
  itemReads: string[];
  dropItems: () => void;
} {
  const store = new MemorySegmentCacheStore();
  const items = new Map<string, Omit<CacheItemResult, "shouldRevalidate">>();
  const itemReads: string[] = [];
  Object.assign(store, {
    async getItem(key: string): Promise<CacheItemResult | null> {
      itemReads.push(key);
      const item = items.get(key);
      return item ? { ...item, shouldRevalidate: false } : null;
    },
    async setItem(
      key: string,
      value: string,
      options?: CacheItemOptions,
    ): Promise<void> {
      items.set(key, { value, handles: options?.handles, tags: options?.tags });
    },
  });
  return { store, itemReads, dropItems: () => items.clear() };
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(body).text();
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

const ssrModule = {
  async renderHTML(rscStream: ReadableStream<Uint8Array>) {
    await readAll(rscStream);
    return streamOf("<html><body>AXIS-1</body></html>");
  },
  async resumeShellHTML(rscStream: ReadableStream<Uint8Array>) {
    return rscStream;
  },
  async captureShellHTML(
    rscStream: ReadableStream<Uint8Array>,
    options: { quiesce: Promise<unknown> },
  ) {
    const reader = rscStream.getReader();
    void (async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) return;
      }
    })();
    await options.quiesce;
    return { prelude: new TextEncoder().encode(PRELUDE), postponed: null };
  },
} as unknown as SSRModule;

type Router = ReturnType<typeof createRouter>;

function makeCtx(router: Router): HandlerContext<unknown> {
  return {
    version: "v-prune",
    router,
    callOnError: vi.fn(),
    renderToReadableStream: (payload: RscPayload, options?: object) =>
      renderToReadableStream(payload, options),
    loadSSRModule: async () => ssrModule,
    resolveStreamMode: async () => "stream",
  } as unknown as HandlerContext<unknown>;
}

interface Served {
  response: Response;
  body: string;
}

/**
 * Serve one request through handleRscRendering and settle every background
 * task it scheduled (the MISS's capture included).
 */
async function serve(
  router: Router,
  store: MemorySegmentCacheStore,
  path: string,
  init: { partial?: boolean; headers?: Record<string, string> } = {},
): Promise<Served> {
  const url = new URL(
    init.partial
      ? `http://localhost${path}${path.includes("?") ? "&" : "?"}_rsc_partial=true&_rsc_segments=`
      : `http://localhost${path}`,
  );
  const request = new Request(url, {
    headers: {
      accept: init.partial ? "text/x-component" : "text/html",
      ...(init.partial
        ? {
            "X-RSC-Router-Client-Path": "/from",
            "X-Rango-Fragment-Passthrough": "1",
          }
        : {}),
      ...init.headers,
    },
  });
  const reqCtx = createRequestContext({
    env: {},
    request,
    url,
    variables: {},
    cacheStore: store,
    cacheProfiles: { default: { ttl: 300 } },
  }) as RequestContext<unknown>;
  const tasks: Promise<unknown>[] = [];
  reqCtx.waitUntil = (task: () => Promise<void>) => {
    tasks.push(Promise.resolve().then(task));
  };
  const ctx = makeCtx(router);
  const response = await runWithRequestContext(reqCtx, async () => {
    // What rsc/handler.ts does before dispatching the render.
    const plan = await classifyRequest(request, url, {
      // The internal router has it; the public Rango type does not.
      findMatch: (router as unknown as ClassifyRequestDeps).findMatch,
      routerVersion: ctx.version,
      routerId: router.id,
    });
    if (plan.mode !== "full-render" && plan.mode !== "partial-render") {
      throw new Error(`unexpected request plan ${plan.mode}`);
    }
    setRequestContextParams(plan.route.params, plan.route.routeKey);
    reqCtx._classifiedRoute = plan.route;
    return handleRscRendering(
      ctx,
      request,
      {},
      url,
      init.partial ?? false,
      reqCtx._handleStore,
      undefined,
    );
  });
  const body = await readAll(response.body!);
  while (tasks.length > 0) await Promise.allSettled(tasks.splice(0));
  return { response, body };
}

const SHELL_KEY = (path: string, partition?: string) =>
  `localhost${path}:shell${partition === undefined ? "" : `|${encodeURIComponent(partition)}`}`;

async function storedEntry(
  store: MemorySegmentCacheStore,
  path: string,
  partition?: string,
): Promise<ShellCacheEntry> {
  const hit = await store.getShell(SHELL_KEY(path, partition));
  if (!hit) throw new Error(`no shell stored for ${path}`);
  return hit.entry;
}

function families(snapshot: ShellSnapshotRecord[] | undefined): string[] {
  return (snapshot ?? []).map((r) => `${r.family}:${r.key.split(":")[0]}`);
}

async function makeRouter(
  routes: Parameters<Router["routes"]>[0],
): Promise<Router> {
  const router = createRouter({} as any);
  router.routes(routes);
  await buildRouterTrieFromUrlpatterns(router);
  return router;
}

async function ShellLayout(): Promise<React.ReactNode> {
  return <main>{await renderChrome("header")}</main>;
}

async function CatalogPage(ctx: {
  pathname: string;
}): Promise<React.ReactNode> {
  const catalog = await getCatalog(ctx.pathname);
  return (
    <section>
      <p>{catalog.length} products</p>
      {await renderCatalog(ctx.pathname)}
    </section>
  );
}

/**
 * MISS then capture, then move the source on and drop the live items: from
 * here a tail that reads an item live renders generation 2.
 */
async function captureThenDrift(
  router: Router,
  harness: ReturnType<typeof makeStore>,
  path: string,
  headers?: Record<string, string>,
  partition?: string,
): Promise<ShellCacheEntry> {
  const miss = await serve(router, harness.store, path, { headers });
  expect(miss.response.headers.get("x-rango-shell")).toBe("MISS");
  const entry = await storedEntry(harness.store, path, partition);
  source.generation = 2;
  harness.dropItems();
  harness.itemReads.length = 0;
  return entry;
}

beforeEach(() => {
  source.generation = 1;
  pruneInputs.length = 0;
});

describe("PPR snapshot pruning: a covered document capture", () => {
  it("stores no handler-only item records, and its HIT tail is byte-identical to the unpruned HIT", async () => {
    const router = await makeRouter(({ layout, path }: any) => [
      layout(ShellLayout, () => [
        path("/p", CatalogPage, { name: "prunePage", ppr: { ttl: 300 } }),
      ]),
    ]);
    const harness = makeStore();

    const pruned = await captureThenDrift(router, harness, "/p");
    expect(pruneInputs).toHaveLength(1);
    const unprunedSnapshot = pruneInputs[0] as ShellSnapshotRecord[];
    expect(
      families(unprunedSnapshot).filter((f) => f.startsWith("item:")),
    ).toHaveLength(3);
    expect(families(pruned.snapshot)).toEqual(["segment:doc"]);
    expect(pruned.prunedRecords).toBe("item:3");

    const prunedHit = await serve(router, harness.store, "/p");
    expect(prunedHit.response.headers.get("x-rango-shell")).toBe("HIT");
    expect(harness.itemReads).toEqual([]);

    await harness.store.putShell(
      SHELL_KEY("/p"),
      { ...pruned, snapshot: unprunedSnapshot, prunedRecords: undefined },
      300,
    );
    const unprunedHit = await serve(router, harness.store, "/p");
    expect(unprunedHit.response.headers.get("x-rango-shell")).toBe("HIT");

    expect(prunedHit.body.startsWith(PRELUDE)).toBe(true);
    expect(prunedHit.body).toContain("@g1");
    expect(prunedHit.body).not.toContain("@g2");
    expect(prunedHit.body).toBe(unprunedHit.body);
  });
});

describe("PPR snapshot pruning: no HIT runs a handler, so every document entry prunes", () => {
  // Every document HIT replays the handler layer from the entry's own doc
  // record, looked up by the key the capture wrote. None of these shapes
  // re-runs a handler any more, so none keeps a handler-read record, and every
  // HIT renders the capture's generation (@g1) while the source moved on.
  const explicitStore = new MemorySegmentCacheStore();
  const variants: Array<{
    name: string;
    options: PartialCacheOptions;
    capture?: Record<string, string>;
    hit?: Record<string, string>;
    beforeHit?: () => Promise<void> | void;
    pruned: string;
    /** The request partition the route's key() gives the capture and HIT. */
    partition?: string;
  }> = [
    {
      name: "explicit miss: the explicit store lost its record",
      options: { ttl: 300, store: explicitStore },
      beforeHit: () => explicitStore.clear(),
      pruned: "item:3",
    },
    {
      // The explicit tier writes to the app store here; the capture records
      // no segment besides the doc record.
      pruned: "item:3",
      name: "custom key(): a HIT in the capture's own partition",
      options: {
        ttl: 300,
        key: (ctx) => `variant:${ctx.request.headers.get("x-variant")}`,
      },
      capture: { "x-variant": "a" },
      hit: { "x-variant": "a" },
      partition: "variant:a",
    },
  ];

  it.each(variants)(
    "route-derived cache() scope, $name",
    async ({ options, capture, hit, beforeHit, pruned, partition }) => {
      const router = await makeRouter(({ layout, path, cache }: any) => [
        layout(ShellLayout, () => [
          cache(options, () => [
            path("/scoped", CatalogPage, {
              name: "scoped",
              ppr: { ttl: 300 },
            }),
          ]),
        ]),
      ]);
      const harness = makeStore();

      const entry = await captureThenDrift(
        router,
        harness,
        "/scoped",
        capture,
        partition,
      );
      expect(entry.docKey).toBe("doc:localhost/scoped");
      expect(entry.prunedRecords).toBe(pruned);

      await beforeHit?.();
      const served = await serve(router, harness.store, "/scoped", {
        headers: hit,
      });
      expect(served.response.headers.get("x-rango-shell")).toBe("HIT");
      expect(harness.itemReads).toEqual([]);
      expect(served.body).toContain("header@g1");
      expect(served.body).not.toContain("@g2");
    },
  );

  it("route-derived cache() scope, condition() refuses the HIT's read: a genuine MISS before the commit", async () => {
    let allowCache = true;
    const router = await makeRouter(({ layout, path, cache }: any) => [
      layout(ShellLayout, () => [
        cache({ ttl: 300, condition: () => allowCache }, () => [
          path("/scoped", CatalogPage, { name: "scoped", ppr: { ttl: 300 } }),
        ]),
      ]),
    ]);
    const harness = makeStore();
    await captureThenDrift(router, harness, "/scoped");

    allowCache = false;
    const served = await serve(router, harness.store, "/scoped");
    // Decided before any shell byte: no x-rango-shell, a normal render.
    expect(served.response.headers.get("x-rango-shell")).toBeNull();
    expect(served.body).toBe("<html><body>AXIS-1</body></html>");
  });

  it("a store keyGenerator: the shell and its docKey are the partition's own", async () => {
    const router = await makeRouter(({ layout, path }: any) => [
      layout(ShellLayout, () => [
        path("/segmented", CatalogPage, {
          name: "segmented",
          ppr: { ttl: 300 },
        }),
      ]),
    ]);
    const harness = makeStore();
    Object.assign(harness.store, {
      keyGenerator: (ctx: RequestContext, defaultKey: string) =>
        `${defaultKey}|${ctx.request.headers.get("x-segment") ?? ""}`,
    });

    const entry = await captureThenDrift(
      router,
      harness,
      "/segmented",
      { "x-segment": "a" },
      "doc:localhost/segmented|a",
    );
    expect(entry.docKey).toBe("doc:localhost/segmented|a");
    expect(entry.prunedRecords).toBe("item:3");

    const served = await serve(router, harness.store, "/segmented", {
      headers: { "x-segment": "a" },
    });
    expect(served.response.headers.get("x-rango-shell")).toBe("HIT");
    expect(harness.itemReads).toEqual([]);
    expect(served.body).toContain("/segmented-item-0@g1");
    expect(served.body).not.toContain("@g2");
  });

  it("a handler-invoked loader: its value is baked and replayed, the handler never re-runs", async () => {
    let priceRuns = 0;
    const PriceLoader = (createLoader as Function)(
      async () => ({ price: `price-${++priceRuns}` }),
      undefined,
      "test#PrunePriceLoader",
    );
    async function PricedPage(ctx: any) {
      const { price } = await ctx.use(PriceLoader);
      return (
        <section>
          <p>{price}</p>
          {await renderCatalog(ctx.pathname)}
        </section>
      );
    }
    const router = await makeRouter(({ layout, path }: any) => [
      layout(ShellLayout, () => [
        path("/priced", PricedPage, { name: "priced", ppr: { ttl: 300 } }),
      ]),
    ]);
    const harness = makeStore();

    const entry = await captureThenDrift(router, harness, "/priced");
    expect(entry.prunedRecords).toBe("item:2");
    const capturedPrice = `price-${priceRuns}`;

    const served = await serve(router, harness.store, "/priced");
    expect(served.response.headers.get("x-rango-shell")).toBe("HIT");
    expect(`price-${priceRuns}`).toBe(capturedPrice);
    expect(served.body).toContain(capturedPrice);
    expect(harness.itemReads).toEqual([]);
    expect(served.body).toContain("/priced-item-0@g1");
    expect(served.body).not.toContain("@g2");
  });

  it("R2.4 an item a bake-lane loader read stays pinned; handler-only items are pruned", async () => {
    const BakeLoader = (createLoader as Function)(
      async () => ({ stamp: await getStamp("bake") }),
      undefined,
      "test#PruneBakeLoader",
    );
    const router = await makeRouter(({ layout, path, loader }: any) => [
      layout(ShellLayout, () => [
        path(
          "/baked",
          CatalogPage,
          { name: "baked", ppr: { ttl: 300 } },
          () => [loader(BakeLoader, { ssr: false })],
        ),
      ]),
    ]);
    const harness = makeStore();

    const entry = await captureThenDrift(router, harness, "/baked");
    expect(
      entry.snapshot
        ?.filter((r) => r.family === "item")
        .map((r) => r.key.includes("getStamp")),
    ).toEqual([true]);
    expect(families(entry.snapshot).sort()).toEqual([
      "item:use-cache",
      "loader:M0L0L0R0D0.test#PruneBakeLoader",
      "segment:doc",
    ]);
    expect(entry.prunedRecords).toBe("item:3");

    const served = await serve(router, harness.store, "/baked");
    expect(served.response.headers.get("x-rango-shell")).toBe("HIT");
    // A promise-free bake-lane loader is served from its pin and does not
    // run on the HIT: nothing reads the item store.
    expect(harness.itemReads).toEqual([]);
    expect(served.body).toContain("bake-stamp@g1");
    expect(served.body).not.toContain("@g2");
  });
});

describe("PPR snapshot pruning: a live hole reading a key the shell also read", () => {
  // Decision 3 (docs/design/shell-entry-layout.md): holes are the live lane.
  // The shell keeps showing the value it was captured with; the hole's loader
  // reads the store.
  it("the shell shows the capture value and the hole the live value", async () => {
    const StampLoader = (createLoader as Function)(
      async () => ({ stamp: await getStamp("shared") }),
      undefined,
      "test#PruneSharedStampLoader",
    );
    async function StampLayout() {
      return <main data-part="shell">{await getStamp("shared")}</main>;
    }
    const router = await makeRouter(
      ({ layout, path, loader, loading }: any) => [
        layout(StampLayout, () => [
          path(
            "/shared",
            () => <p>page</p>,
            { name: "shared", ppr: { ttl: 300 } },
            () => [loader(StampLoader), loading(<p>loading stamp</p>)],
          ),
        ]),
      ],
    );
    const harness = makeStore();

    const entry = await captureThenDrift(router, harness, "/shared");
    expect(families(entry.snapshot)).toEqual(["segment:doc"]);
    expect(entry.prunedRecords).toBe("item:1");

    const served = await serve(router, harness.store, "/shared");
    expect(served.response.headers.get("x-rango-shell")).toBe("HIT");
    // The layout's stamp rides the doc record's fragment (escaped JSON).
    expect(served.body).toContain('\\"children\\":\\"shared-stamp@g1\\"');
    expect(served.body).toMatch(/"stamp":"shared-stamp@g2"/);
    expect(served.body).not.toMatch(/"stamp":"shared-stamp@g1"/);
  });
});

describe("PPR snapshot pruning: partial navigation replay", () => {
  it("a pruned entry replays the same segments as the unpruned one", async () => {
    const router = await makeRouter(({ layout, path }: any) => [
      layout(ShellLayout, () => [
        path("/nav", CatalogPage, { name: "nav", ppr: { ttl: 300 } }),
      ]),
    ]);
    const harness = makeStore();

    const pruned = await captureThenDrift(router, harness, "/nav");
    expect(pruned.prunedRecords).toBe("item:3");
    const unprunedSnapshot = pruneInputs[0] as ShellSnapshotRecord[];

    const fromPruned = await serve(router, harness.store, "/nav", {
      partial: true,
    });
    expect(fromPruned.response.headers.get("x-rango-ppr-replay")).toMatch(
      /^HIT/,
    );

    await harness.store.putShell(
      SHELL_KEY("/nav"),
      { ...pruned, snapshot: unprunedSnapshot, prunedRecords: undefined },
      300,
    );
    const fromUnpruned = await serve(router, harness.store, "/nav", {
      partial: true,
    });
    expect(fromUnpruned.response.headers.get("x-rango-ppr-replay")).toMatch(
      /^HIT/,
    );

    expect(fromPruned.body).toContain("/nav-item-0@g1");
    expect(fromPruned.body).toBe(fromUnpruned.body);
  });
});

describe("PPR snapshot pruning: a doc record that fails to decode on a HIT", () => {
  // The tail cannot replay the handler layer and must not run handlers behind
  // the committed prelude: the entry is replaced with a tombstone, the page
  // reloads, and that reload is a genuine MISS whose capture heals the key.
  it("reports cache-corrupt, runs no handler, reloads the page into a MISS, and recaptures", async () => {
    let pageRuns = 0;
    async function CountedPage(ctx: { pathname: string }) {
      pageRuns++;
      return CatalogPage(ctx);
    }
    const router = await makeRouter(({ layout, path }: any) => [
      layout(ShellLayout, () => [
        path("/corrupt", CountedPage, { name: "corrupt", ppr: { ttl: 300 } }),
      ]),
    ]);
    const harness = makeStore();
    const entry = await captureThenDrift(router, harness, "/corrupt");
    expect(entry.prunedRecords).toBe("item:3");
    await harness.store.putShell(
      SHELL_KEY("/corrupt"),
      {
        ...entry,
        snapshot: entry.snapshot!.map((record) =>
          record.key === entry.docKey
            ? {
                ...record,
                value: { ...(record.value as object), segments: [null] },
              }
            : record,
        ) as ShellSnapshotRecord[],
      },
      300,
    );

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const runsBefore = pageRuns;
      const hit = await serve(router, harness.store, "/corrupt");
      expect(hit.response.headers.get("x-rango-shell")).toBe("HIT");
      expect(hit.body.startsWith(PRELUDE)).toBe(true);
      expect(hit.body).toContain(shellReloadScript());
      expect(hit.body).not.toContain("@g");
      expect(
        errors.mock.calls.some((call) =>
          String(call[0]).includes("corrupt cached segments"),
        ),
      ).toBe(true);
      // The HIT itself ran no handler; the recapture it scheduled did.
      expect(pageRuns).toBe(runsBefore + 1);

      // The recapture replaced the tombstone with a sound entry at g2.
      const healed = await storedEntry(harness.store, "/corrupt");
      expect(healed.navigationOnly).toBeUndefined();
      const healedDoc = healed.snapshot?.find((r) => r.key === healed.docKey)
        ?.value as { segments: unknown[] } | undefined;
      expect(healedDoc?.segments.every((segment) => segment !== null)).toBe(
        true,
      );
      errors.mockClear();
      harness.itemReads.length = 0;
      const next = await serve(router, harness.store, "/corrupt");
      expect(next.response.headers.get("x-rango-shell")).toBe("HIT");
      expect(harness.itemReads).toEqual([]);
      expect(next.body).toContain("/corrupt-item-0@g2");
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("the tombstone serves the next document request as a MISS until the recapture lands", async () => {
    const router = await makeRouter(({ layout, path }: any) => [
      layout(ShellLayout, () => [
        path("/tomb", CatalogPage, { name: "tomb", ppr: { ttl: 300 } }),
      ]),
    ]);
    const harness = makeStore();
    const entry = await captureThenDrift(router, harness, "/tomb");
    // What the degrade writes (rsc-rendering.ts degradeUnreplayableShell).
    await harness.store.putShell(
      SHELL_KEY("/tomb"),
      {
        reactVersion: entry.reactVersion,
        buildVersion: entry.buildVersion,
        snapshot: [],
        navigationOnly: true,
        createdAt: Date.now(),
      },
      300,
    );
    const next = await serve(router, harness.store, "/tomb");
    expect(next.response.headers.get("x-rango-shell")).toBe("MISS");
  });
});
