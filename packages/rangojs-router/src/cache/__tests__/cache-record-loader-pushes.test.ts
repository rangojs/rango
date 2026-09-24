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
import { createHandle } from "../../handle.js";
import { buildRouterTrieFromUrlpatterns } from "../../rsc/manifest-init.js";
import { MemorySegmentCacheStore } from "../memory-segment-store.js";
import { decodeHandles } from "../handle-snapshot.js";
import { deriveShellCaptureContext } from "../../rsc/shell-capture.js";
import type { RecordingShellStore } from "../shell-snapshot.js";
import type { CachedEntryData } from "../types.js";
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
 * Crumbs values in the doc segment record that a fast-path HIT replays.
 */
async function captureDocRecordCrumbs(pathname: string): Promise<unknown[]> {
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
  const doc = recording
    .drainSnapshot()
    ?.find((r) => r.family === "segment" && r.key.startsWith("doc:"));
  expect(doc, "capture wrote the doc segment record").toBeDefined();
  const handles = await decodeHandles((doc!.value as CachedEntryData).handles);
  return Object.values(handles ?? {}).flatMap(
    (segHandles) => segHandles[Crumbs.$$id] ?? [],
  );
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

  it("does not record an object pushed by a loader the bake-lane loader awaits", () => {
    expect(withLabel(recorded, "awaited-object")).toHaveLength(0);
  });

  it("does not record a primitive pushed by a loader the bake-lane loader awaits", () => {
    expect(recorded).not.toContain("awaited-string");
  });

  it("does not record a bake-lane loader's pushes replayed from its own cache(), primitive or object", async () => {
    // Foreground MISS writes the loader-cache entry; the capture then hits it.
    await serve("/ppr-cached-crumbs");
    const cached = await captureDocRecordCrumbs("/ppr-cached-crumbs");

    expect(shellCachedBakedLoaderBody).toHaveBeenCalledTimes(1);
    expect(cached).toContain("handler-string");
    expect(cached).not.toContain("cached-baked-string");
    expect(withLabel(cached, "cached-baked-object")).toHaveLength(0);
  });
});
