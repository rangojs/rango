import { describe, it, expect, vi, beforeAll } from "vitest";

// cacheRoute serializes segments and handles through segment-codec, whose real
// RSC codec needs a Flight runtime vitest lacks. Same JSON stand-in as
// cache-store-shell-doc-record.test.ts, mocked at the virtual-module seam.
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
import { createRouter } from "../../router.js";
import { createLoader } from "../../loader.rsc.js";
import { collectHandleData, createHandle } from "../../handle.js";
import { Meta } from "../../handles/meta.js";
import { buildRouterTrieFromUrlpatterns } from "../../rsc/manifest-init.js";
import { MemorySegmentCacheStore } from "../memory-segment-store.js";
import { decodeHandles } from "../handle-snapshot.js";
import { deriveShellCaptureContext } from "../../rsc/shell-capture.js";
import {
  SeededShellStore,
  buildShellLoaderSeed,
  type RecordingShellStore,
} from "../shell-snapshot.js";
import type { CachedEntryData, ShellSnapshotRecord } from "../types.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../server/request-context.js";

// cache() records must not carry handle pushes made from a DSL loader body:
// a HIT runs loaders as an uncached render would, so the live push is the
// only producer. Handler pushes (and handler-invoked ctx.use(Loader) pushes,
// the consumption lane) are skipped on a HIT and must replay from the record. Drives the real
// write (cacheRoute -> captureHandles) and HIT (lookupRoute -> restoreHandles
// -> resolveLoadersOnly) paths through router.match.

const Crumbs = createHandle<unknown>(undefined, "test#CacheRecordCrumbs");

const dslLoaderBody = vi.fn(async (ctx: any) => {
  ctx.use(Crumbs)({ label: "dsl-loader" });
  ctx.use(Crumbs)("dsl-loader-string");
  return { ok: true };
});
const DslLoader = (createLoader as Function)(
  dslLoaderBody,
  undefined,
  "test#CacheRecordDslLoader",
);

const consumedLoaderBody = vi.fn(async (ctx: any) => {
  ctx.use(Crumbs)({ label: "handler-consumed-loader" });
  return { consumed: true };
});
const ConsumedLoader = (createLoader as Function)(
  consumedLoaderBody,
  undefined,
  "test#CacheRecordConsumedLoader",
);

const pageHandler = vi.fn(async (ctx: any) => {
  ctx.use(Crumbs)({ label: "handler" });
  await ctx.use(ConsumedLoader);
  return createElement("div", null, "page");
});

// A DSL loader with its own cache() under the route cache(): on the segment
// HIT it re-runs, hits its loader cache and replays its recorded pushes
// (loader-cache.ts), so the segment record must not carry them as well.
const cachedLoaderBody = vi.fn(async (ctx: any) => {
  ctx.use(Crumbs)({ label: "cached-loader" });
  return { cached: true };
});
const CachedLoader = (createLoader as Function)(
  cachedLoaderBody,
  undefined,
  "test#CacheRecordCachedLoader",
);

// PPR shell capture fixture. An unflagged (live-lane) DSL loader never executes
// at capture (loader-cache.ts resolveLoaderData masks it). An ssr:false
// (bake-lane) loader does, and so does every loader it awaits via ctx.use; on a
// HIT that replays the record the bake-lane loader re-runs and the awaited
// loader re-runs with it.
const shellLiveLoaderBody = vi.fn(async (ctx: any) => {
  ctx.use(Crumbs)("live-string");
  return { live: true };
});
const ShellLiveLoader = (createLoader as Function)(
  shellLiveLoaderBody,
  undefined,
  "test#ShellRecordLiveLoader",
);

const ShellAwaitedLoader = (createLoader as Function)(
  async (ctx: any) => {
    ctx.use(Crumbs)("awaited-string");
    ctx.use(Crumbs)({ label: "awaited-object" });
    return { awaited: true };
  },
  undefined,
  "test#ShellRecordAwaitedLoader",
);

const ShellBakedLoader = (createLoader as Function)(
  async (ctx: any) => {
    ctx.use(Crumbs)("baked-string");
    ctx.use(Crumbs)({ label: "baked-object" });
    await ctx.use(ShellAwaitedLoader);
    return { baked: true };
  },
  undefined,
  "test#ShellRecordBakedLoader",
);

// Bake-lane loader with its own cache(): once the foreground MISS has written
// its loader-cache entry, the capture replays the recorded pushes
// (loader-cache.ts replayLoaderHandles) instead of running the body, and a HIT
// replays them again from the loader's re-run.
const shellCachedBakedLoaderBody = vi.fn(async (ctx: any) => {
  ctx.use(Crumbs)("cached-baked-string");
  ctx.use(Crumbs)({ label: "cached-baked-object" });
  return { cachedBaked: true };
});
const ShellCachedBakedLoader = (createLoader as Function)(
  shellCachedBakedLoaderBody,
  undefined,
  "test#ShellRecordCachedBakedLoader",
);

// Bake-lane loader whose pushes carry its run count, so a HIT tells the
// recorded (capture) value from the live re-run's.
let bakeRepushRun = 0;
const BakeRepushLoader = (createLoader as Function)(
  async (ctx: any) => {
    const run = ++bakeRepushRun;
    ctx.use(Crumbs)(`bake-string-${run}`);
    ctx.use(Crumbs)({ label: `bake-object-${run}` });
    ctx.use(Meta)({ title: `bake-title-${run}` });
    return { baked: true };
  },
  undefined,
  "test#ShellRepushBakeLoader",
);
// Same, with its own cache(): when the capture runs the body (its loader
// cache missed), a HIT that hits the loader cache replays those pushes a
// second time unless the shell restore claims the loader.
let cachedRepushRun = 0;
const CachedRepushLoader = (createLoader as Function)(
  async (ctx: any) => {
    ctx.use(Crumbs)(`cached-repush-${++cachedRepushRun}`);
    return { cachedRepush: true };
  },
  undefined,
  "test#ShellCachedRepushLoader",
);
const repushPageHandler = vi.fn((ctx: any) => {
  ctx.use(Crumbs)("handler-string");
  return createElement("div", null, "ppr-repush");
});

const shellPageHandler = (ctx: any) => {
  ctx.use(Crumbs)("handler-string");
  return createElement("div", null, "ppr-page");
};

const RootLayout = () => createElement("div", null, "layout");

let router: any;
let store: MemorySegmentCacheStore;

beforeAll(async () => {
  store = new MemorySegmentCacheStore();
  router = createRouter({} as any);
  router.routes(({ layout, path, loader, loading, cache }: any) => [
    path(
      "/ppr-crumbs",
      shellPageHandler,
      { name: "shellRecordCrumbs", ppr: true },
      () => [
        loader(ShellBakedLoader, { ssr: false }),
        loader(ShellLiveLoader),
        loading(createElement("span", null, "loading")),
      ],
    ),
    path(
      "/ppr-bake-repush",
      repushPageHandler,
      { name: "shellRecordBakeRepush", ppr: true },
      () => [loader(BakeRepushLoader, { ssr: false })],
    ),
    path(
      "/ppr-cached-bake-repush",
      repushPageHandler,
      { name: "shellRecordCachedBakeRepush", ppr: true },
      () => [
        loader(CachedRepushLoader, { ssr: false }, () => [
          cache({ ttl: 60, store: new MemorySegmentCacheStore() }),
        ]),
      ],
    ),
    path(
      "/ppr-cached-crumbs",
      shellPageHandler,
      { name: "shellRecordCachedCrumbs", ppr: true },
      () => [
        loader(ShellCachedBakedLoader, { ssr: false }, () => [
          cache({ ttl: 60, store: new MemorySegmentCacheStore() }),
        ]),
      ],
    ),
    cache({ ttl: 60, store }, () => [
      layout(RootLayout, () => [
        path("/crumbs", pageHandler, { name: "cacheRecordCrumbs" }, () => [
          loader(DslLoader),
        ]),
        path(
          "/cached-loader",
          () => createElement("div", null, "cached-loader-page"),
          { name: "cacheRecordCachedLoader" },
          () => [
            loader(CachedLoader, () => [
              cache({ ttl: 60, store: new MemorySegmentCacheStore() }),
            ]),
          ],
        ),
      ]),
    ]),
  ]);
  await buildRouterTrieFromUrlpatterns(router);
});

async function serve(pathname: string): Promise<RequestContext<any>> {
  const request = new Request(`https://example.com${pathname}`, {
    headers: { accept: "text/html" },
  });
  const reqCtx = createRequestContext({
    env: {},
    request,
    url: new URL(request.url),
    variables: {},
  } as any) as RequestContext<any>;
  await runWithRequestContext(reqCtx, async () => {
    await router.match(request, { env: {} });
    // Stand-in for the RSC handler: seal the store, fire onResponse
    // (schedules the cache write), and drain every background task it chains.
    reqCtx._handleStore.seal();
    await reqCtx._handleStore.fullySettled;
    for (const cb of reqCtx._onResponseCallbacks) {
      cb(new Response(null, { status: 200 }));
    }
    const tasks = reqCtx._pendingBackgroundTasks!;
    for (let i = 0; i < tasks.length; i++) await tasks[i];
  });
  return reqCtx;
}

async function crumbValues(reqCtx: RequestContext<any>): Promise<unknown[]> {
  const data = await reqCtx._handleStore.getData();
  return Object.values(data[Crumbs.$$id] ?? {}).flat();
}

const DSL_PUSHES = [{ label: "dsl-loader" }, "dsl-loader-string"];
const isDslPush = (v: unknown) =>
  v === "dsl-loader-string" ||
  (v as { label?: string })?.label === "dsl-loader";
const withLabel = (values: unknown[], label: string) =>
  values.filter((v) => (v as { label?: string })?.label === label);

describe("cache() record vs DSL-loader handle pushes (MISS then HIT)", () => {
  let missValues: unknown[];
  let hitValues: unknown[];

  beforeAll(async () => {
    missValues = await crumbValues(await serve("/crumbs"));
    hitValues = await crumbValues(await serve("/crumbs"));
  });

  it("the second request is a HIT: handler skipped, DSL loader re-runs", () => {
    expect(pageHandler).toHaveBeenCalledTimes(1);
    expect(consumedLoaderBody).toHaveBeenCalledTimes(1);
    expect(dslLoaderBody).toHaveBeenCalledTimes(2);
  });

  it("DSL-loader pushes (object and primitive) appear once on a HIT", () => {
    expect(missValues.filter(isDslPush)).toEqual(DSL_PUSHES);
    expect(hitValues.filter(isDslPush)).toEqual(DSL_PUSHES);
  });

  it("handler pushes are recorded and replayed on a HIT", () => {
    expect(withLabel(missValues, "handler")).toHaveLength(1);
    expect(withLabel(hitValues, "handler")).toHaveLength(1);
  });

  it("handler-invoked ctx.use(Loader) pushes are recorded and replayed (consumption lane)", () => {
    // The consumed loader body ran only on the MISS; the HIT value is the
    // recorded copy.
    expect(withLabel(missValues, "handler-consumed-loader")).toHaveLength(1);
    expect(withLabel(hitValues, "handler-consumed-loader")).toHaveLength(1);
  });
});

describe("cache() record vs a loader with its own cache()", () => {
  it("its pushes appear once on the segment MISS and on the segment HIT (replayed from the loader cache)", async () => {
    const miss = await crumbValues(await serve("/cached-loader"));
    const hit = await crumbValues(await serve("/cached-loader"));

    // Body ran on the MISS only; the HIT's copy is the loader-cache replay.
    expect(cachedLoaderBody).toHaveBeenCalledTimes(1);
    expect(withLabel(miss, "cached-loader")).toHaveLength(1);
    expect(withLabel(hit, "cached-loader")).toHaveLength(1);
  });
});

/**
 * Run the real PPR capture match (deriveShellCaptureContext + router.match),
 * fire its onResponse callbacks as captureAndStoreShell does, and return the
 * shell snapshot plus the Crumbs values in the doc segment record that a
 * fast-path HIT replays.
 */
async function captureShell(
  pathname: string,
): Promise<{ snapshot: ShellSnapshotRecord[]; recorded: unknown[] }> {
  const request = new Request(`https://example.com${pathname}`, {
    headers: { accept: "text/html" },
  });
  const reqCtx = createRequestContext({
    env: {},
    request,
    url: new URL(request.url),
    variables: {},
  } as any) as RequestContext<any>;
  reqCtx._cacheStore = new MemorySegmentCacheStore();
  const { derivedCtx } = deriveShellCaptureContext(reqCtx, {
    ttl: 60,
    swr: 0,
  });
  await runWithRequestContext(derivedCtx, async () => {
    await router.match(request, { env: {} });
    derivedCtx._handleStore.seal();
    for (const cb of derivedCtx._onResponseCallbacks) {
      cb(new Response(null, { status: 200 }));
    }
  });
  const recording = derivedCtx._cacheStore as RecordingShellStore;
  await recording.settleWrites(5000);
  const snapshot = recording.drainSnapshot() ?? [];
  const doc = snapshot.find(
    (r) => r.family === "segment" && r.key.startsWith("doc:"),
  );
  expect(doc, "capture wrote the doc segment record").toBeDefined();
  const handles = await decodeHandles((doc!.value as CachedEntryData).handles);
  const recorded = Object.values(handles ?? {}).flatMap(
    (segHandles) => segHandles[Crumbs.$$id] ?? [],
  );
  return { snapshot, recorded };
}

async function captureDocRecordCrumbs(pathname: string): Promise<unknown[]> {
  return (await captureShell(pathname)).recorded;
}

/**
 * Serve a shell HIT tail armed as serveShellHit arms it: the snapshot seeds
 * the store and the bake-lane loader seed, and the implicit doc scope HITs
 * the recorded doc record (handler layer replayed, loaders re-run).
 */
async function serveShellHitTail(
  pathname: string,
  snapshot: ShellSnapshotRecord[],
): Promise<RequestContext<any>> {
  const request = new Request(`https://example.com${pathname}`, {
    headers: { accept: "text/html" },
  });
  const reqCtx = createRequestContext({
    env: {},
    request,
    url: new URL(request.url),
    variables: {},
  } as any) as RequestContext<any>;
  reqCtx._cacheStore = new SeededShellStore(
    new MemorySegmentCacheStore(),
    snapshot,
  );
  const loaderSeed = await buildShellLoaderSeed(snapshot);
  if (loaderSeed) reqCtx._shellLoaderSeed = loaderSeed;
  reqCtx._shellImplicitCache = { ttl: 60, swr: 0, keyPrefix: "doc" };
  await runWithRequestContext(reqCtx, async () => {
    await router.match(request, { env: {} });
    reqCtx._handleStore.seal();
    await reqCtx._handleStore.fullySettled;
  });
  return reqCtx;
}

describe("PPR shell capture record vs loader handle pushes", () => {
  let recorded: unknown[];

  beforeAll(async () => {
    recorded = await captureDocRecordCrumbs("/ppr-crumbs");
  });

  it("an unflagged (live-lane) loader does not execute at capture", () => {
    expect(shellLiveLoaderBody).not.toHaveBeenCalled();
    expect(recorded).not.toContain("live-string");
  });

  it("records the handler push", () => {
    expect(recorded).toContain("handler-string");
  });

  it("records a bake-lane (ssr: false) loader's own pushes, primitive and object", () => {
    expect(recorded).toContain("baked-string");
    expect(withLabel(recorded, "baked-object")).toHaveLength(1);
  });

  // A HIT does not run a promise-free bake-lane loader, so the loaders it
  // awaited do not run either: the record keeps their settled pushes too.
  it("records an object pushed by a loader the bake-lane loader awaits", () => {
    expect(withLabel(recorded, "awaited-object")).toHaveLength(1);
  });

  it("records a primitive pushed by a loader the bake-lane loader awaits", () => {
    expect(recorded).toContain("awaited-string");
  });

  // A HIT does not run the promise-free bake-lane loader, so the pushes its
  // own cache() replayed at capture are recorded under it like live ones.
  it("records a bake-lane loader's pushes replayed from its own cache(), primitive and object", async () => {
    // Foreground MISS writes the loader-cache entry; the capture then hits it.
    await serve("/ppr-cached-crumbs");
    const cached = await captureDocRecordCrumbs("/ppr-cached-crumbs");

    expect(shellCachedBakedLoaderBody).toHaveBeenCalledTimes(1);
    expect(cached).toContain("handler-string");
    expect(cached).toContain("cached-baked-string");
    expect(withLabel(cached, "cached-baked-object")).toHaveLength(1);
  });
});

describe("PPR shell HIT vs a bake-lane loader's recorded handle pushes", () => {
  let snapshot: ShellSnapshotRecord[];
  let recorded: unknown[];
  let hit: RequestContext<any>;

  beforeAll(async () => {
    ({ snapshot, recorded } = await captureShell("/ppr-bake-repush"));
    repushPageHandler.mockClear();
    hit = await serveShellHitTail("/ppr-bake-repush", snapshot);
  });

  it("the capture records the pushes; the HIT replays the handler and re-runs the loader", () => {
    expect(recorded).toEqual([
      "bake-string-1",
      { label: "bake-object-1" },
      "handler-string",
    ]);
    expect(repushPageHandler).not.toHaveBeenCalled();
    expect(bakeRepushRun).toBe(2);
  });

  it("a string and an object push appear once, with the live value in the recorded position", async () => {
    expect(await crumbValues(hit)).toEqual([
      "bake-string-2",
      { label: "bake-object-2" },
      "handler-string",
    ]);
  });

  it("Meta (deduped by key) collects one title, the live one", async () => {
    const data = await hit._handleStore.getData();
    const order = Object.keys(data[Meta.$$id] ?? {});
    const titles = collectHandleData(Meta, data, order).filter(
      (d) => "title" in d,
    );
    expect(titles).toEqual([{ title: "bake-title-2" }]);
  });

  it("a record without owner info (written before it) restores every recorded value as before", async () => {
    const legacy = snapshot.map((r) => {
      if (r.family !== "segment" || !r.key.startsWith("doc:")) return r;
      const { handleOwners: _, ...value } = r.value as CachedEntryData;
      return { ...r, value };
    });
    const legacyHit = await serveShellHitTail("/ppr-bake-repush", legacy);
    expect(await crumbValues(legacyHit)).toEqual([
      "bake-string-1",
      { label: "bake-object-1" },
      "handler-string",
      "bake-string-3",
      { label: "bake-object-3" },
    ]);
  });

  it("with its own cache(): a HIT that hits the loader cache keeps one copy", async () => {
    // The capture's loader cache misses, so the body runs and the record
    // keeps its push; the capture also writes the loader-cache entry.
    const captured = await captureShell("/ppr-cached-bake-repush");
    expect(captured.recorded).toContain("cached-repush-1");

    const cachedHit = await serveShellHitTail(
      "/ppr-cached-bake-repush",
      captured.snapshot,
    );
    expect(cachedRepushRun).toBe(1);
    expect(await crumbValues(cachedHit)).toEqual([
      "cached-repush-1",
      "handler-string",
    ]);
  });
});
