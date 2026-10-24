/**
 * A route under cache({ ttl, swr }) whose handler reads its own DSL loader
 * (`await ctx.use(PageData)`) shows the loader's handle pushes once on every
 * request: the MISS, the stale HIT that starts the background refresh, and
 * the HIT that reads the refreshed record. So does a layout handler that
 * reads its own loader, and the refresh reads a loader with its own cache()
 * through that cache().
 *
 * A record never holds a DSL loader's pushes (captureHandles drops them): a
 * HIT runs the loader live, and its run supplies them. The refresh
 * (background-revalidation.ts rerenderAndCacheRoute) skips loaders, so the
 * handler's read used to start the loader bare, as a handler-invoked loader
 * whose pushes the record keeps. Every later HIT then showed them twice: the
 * record's copy and the live run's. A partial request whose client holds the
 * layout writes its record through the same re-render, so its first HIT
 * already did.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import { collectHandle } from "../collect-handle.js";
import {
  resetShellTestState,
  serveShellRequest,
  type ServeShellRequestOptions,
  type ServeShellRequestResult,
} from "../flight.entry.js";
import {
  cacheTag,
  createHandle,
  createLoader,
  createRouter,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import {
  VercelCacheStore,
  type VercelRuntimeCache,
} from "../../cache/index.js";
import type { SegmentCacheStore } from "../../cache/types.js";
import { deserializeResult } from "../../cache/segment-codec.js";

function vercelCache(): VercelRuntimeCache {
  const values = new Map<string, unknown>();
  return {
    async get(key) {
      const value = values.get(key);
      return value === undefined ? undefined : structuredClone(value);
    },
    async set(key, value) {
      values.set(key, structuredClone(value));
    },
    async delete(key) {
      values.delete(key);
    },
    async expireTag() {},
  };
}

/** The real clock, moved forward by hand. */
function movableClock(): { advance: (ms: number) => void } {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  return { advance: (ms) => (offset += ms) };
}

const Breadcrumbs = createHandle<string, string[]>((segments) =>
  segments.flat(),
);

const runs = { pageData: 0, sideData: 0, cachedData: 0 };

/** Read by the page's handler; pushes a crumb and tags what reads it. */
const PageData = createLoader(async (ctx) => {
  runs.pageData += 1;
  ctx.use(Breadcrumbs)("page-data-crumb");
  cacheTag("page-data");
  return { title: "Page" };
});

/** Declared beside PageData and read by nothing. */
const SideData = createLoader(async (ctx) => {
  runs.sideData += 1;
  ctx.use(Breadcrumbs)("side-data-crumb");
  cacheTag("side-data");
  return { side: true };
});

/** The loader of a layout the route declares (an orphan layout). */
const AsideData = createLoader(async (ctx) => {
  ctx.use(Breadcrumbs)("aside-data-crumb");
  return { aside: true };
});

function Aside(ctx: HandlerContext): React.ReactNode {
  ctx.use(Breadcrumbs)("aside-crumb");
  return <aside>aside</aside>;
}

function Layout(ctx: HandlerContext): React.ReactNode {
  ctx.use(Breadcrumbs)("layout-crumb");
  return <main>shell</main>;
}

async function Page(ctx: HandlerContext): Promise<React.ReactNode> {
  const { title } = await ctx.use(PageData);
  return <h1>{title}</h1>;
}

const SectionData = createLoader(async (ctx) => {
  ctx.use(Breadcrumbs)("section-data-crumb");
  return { section: "Section" };
});

/** A layout handler that reads its own loader. */
async function Section(ctx: HandlerContext): Promise<React.ReactNode> {
  const { section } = await ctx.use(SectionData);
  return <section>{section}</section>;
}

/** A loader with its own cache(). */
const CachedData = createLoader(async (ctx) => {
  runs.cachedData += 1;
  ctx.use(Breadcrumbs)("cached-data-crumb");
  return { cached: true };
});

async function CachedPage(ctx: HandlerContext): Promise<React.ReactNode> {
  await ctx.use(CachedData);
  return <p>cached</p>;
}

const router = createRouter({}).routes(
  urls(({ path, cache, layout, loader }) => [
    cache({ ttl: 0, swr: 60 }, () => [
      layout(Layout, () => [
        path("/list", () => <ul>list</ul>, { name: "list" }),
        path("/page", Page, { name: "page" }, () => [
          loader(PageData),
          loader(SideData),
          layout(Aside, () => [loader(AsideData)]),
        ]),
      ]),
      layout(Section, () => [
        loader(SectionData),
        path("/section", () => <p>section</p>, { name: "section" }),
      ]),
      path("/cached", CachedPage, { name: "cached" }, () => [
        loader(CachedData, () => [cache({ ttl: 60, tags: ["cached-data"] })]),
      ]),
    ]),
  ]),
);

type HandleData = Record<string, Record<string, unknown[]>>;

async function handlesOf(result: ServeShellRequestResult): Promise<HandleData> {
  const handles = await result.readHandles();
  return (handles?.late.at(-1) ?? handles?.hydration ?? {}) as HandleData;
}

/** The segment ids the response matched, the order useHandle collects in. */
async function matchedOf(result: ServeShellRequestResult): Promise<string[]> {
  return (await deserializeResult<any>(result.flight!)).metadata.matched;
}

/**
 * The Breadcrumbs value useHandle shows once the response lands on a client
 * that shows `before`: a segment the response carries replaces the client's.
 */
async function crumbs(
  result: ServeShellRequestResult,
  before: HandleData,
): Promise<string[]> {
  const after = await handlesOf(result);
  const bySegment: Record<string, string[]> = {
    ...(before[Breadcrumbs.$$id] as Record<string, string[]>),
    ...(after[Breadcrumbs.$$id] as Record<string, string[]>),
  };
  const order = await matchedOf(result);
  return collectHandle(
    Breadcrumbs,
    order.map((id) => bySegment[id] ?? []),
  );
}

interface StoreWrite {
  key: string;
  data: any;
}

function recordingStore(): { store: SegmentCacheStore; writes: StoreWrite[] } {
  const store = new VercelCacheStore({ cache: vercelCache() });
  const writes: StoreWrite[] = [];
  const set = store.set.bind(store);
  vi.spyOn(store, "set").mockImplementation(async (key, data, ttl, swr) => {
    writes.push({ key, data: structuredClone(data) });
    return set(key, data, ttl, swr);
  });
  return { store, writes };
}

/** A route record's segments, handles and tags, comparable across writes. */
function recordOf(data: any) {
  return {
    segments: data.segments.map((s: any) => ({
      ...s.metadata,
      encoded: s.encoded,
      layout: s.encodedLayout,
      loading: s.encodedLoading,
    })),
    handles: data.handles,
    handleOwners: data.handleOwners,
    tags: data.tags ? [...data.tags].sort() : data.tags,
  };
}

type Shape = "document" | "navigation" | "navigation, layout held";

const SHAPES: readonly Shape[] = [
  "document",
  "navigation",
  "navigation, layout held",
];

/** How the client asks for /page, and the handles it shows before. */
async function visitOf(shape: Shape): Promise<{
  partial: ServeShellRequestOptions["partial"];
  before: HandleData;
}> {
  if (shape === "document") return { partial: undefined, before: {} };
  if (shape === "navigation") return { partial: true, before: {} };
  const list = await serveShellRequest(router, "/list", {
    cacheStore: new VercelCacheStore({ cache: vercelCache() }),
    partial: true,
  });
  return {
    partial: { from: "/list", segments: await matchedOf(list) },
    before: await handlesOf(list),
  };
}

/** Every crumb the page pushes, once each, sorted. */
const CRUMBS = [
  "aside-crumb",
  "aside-data-crumb",
  "layout-crumb",
  "page-data-crumb",
  "side-data-crumb",
];

describe("cache() route whose handler reads its own DSL loader", () => {
  beforeEach(async () => {
    await resetShellTestState();
    runs.pageData = 0;
    runs.sideData = 0;
    runs.cachedData = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const shape of SHAPES) {
    describe(shape, () => {
      it("shows the loader's crumb once on the MISS, the stale HIT and the refreshed HIT", async () => {
        const clock = movableClock();
        const { store } = recordingStore();
        const { partial, before } = await visitOf(shape);
        const serve = () =>
          serveShellRequest(router, "/page", { cacheStore: store, partial });

        const miss = await serve();
        clock.advance(1_100);
        const stale = await serve();
        clock.advance(1_100);
        const hit = await serve();

        const shown = await crumbs(miss, before);
        expect([...shown].sort()).toEqual(CRUMBS);
        expect(await crumbs(stale, before)).toEqual(shown);
        expect(await crumbs(hit, before)).toEqual(shown);
      });

      it("the refresh writes the record a MISS writes", async () => {
        const clock = movableClock();
        const { store, writes } = recordingStore();
        const { partial } = await visitOf(shape);
        await serveShellRequest(router, "/page", {
          cacheStore: store,
          partial,
        });
        clock.advance(1_100);
        const before = writes.length;
        await serveShellRequest(router, "/page", {
          cacheStore: store,
          partial,
        });
        const refreshed = writes.slice(before);
        expect(refreshed).toHaveLength(1);

        // The foreground MISS of a client that holds nothing, under the
        // same key: every DSL loader starts in its scope.
        const reference = recordingStore();
        await serveShellRequest(router, "/page", {
          cacheStore: reference.store,
          partial: shape === "document" ? undefined : true,
        });
        expect(reference.writes).toHaveLength(1);
        expect(refreshed[0]!.key).toBe(reference.writes[0]!.key);
        expect(recordOf(refreshed[0]!.data)).toEqual(
          recordOf(reference.writes[0]!.data),
        );
      });
    });
  }

  it("a layout handler that reads its own loader shows its crumb once", async () => {
    const clock = movableClock();
    const { store } = recordingStore();
    const shown: string[][] = [];
    for (let i = 0; i < 3; i++) {
      const result = await serveShellRequest(router, "/section", {
        cacheStore: store,
      });
      shown.push(await crumbs(result, {}));
      clock.advance(1_100);
    }
    expect(shown).toEqual([
      ["section-data-crumb"],
      ["section-data-crumb"],
      ["section-data-crumb"],
    ]);
  });

  it("the refresh reads a loader with its own cache() through it", async () => {
    const clock = movableClock();
    const { store, writes } = recordingStore();
    const shown: string[][] = [];
    for (let i = 0; i < 3; i++) {
      const result = await serveShellRequest(router, "/cached", {
        cacheStore: store,
      });
      shown.push(await crumbs(result, {}));
      clock.advance(1_100);
    }
    // The MISS runs it and stores it; every later read hits that entry.
    expect(runs.cachedData).toBe(1);
    expect(shown).toEqual([
      ["cached-data-crumb"],
      ["cached-data-crumb"],
      ["cached-data-crumb"],
    ]);
    // The refreshed record answers for the loader cache()'s tags, as the
    // MISS's does: invalidating one evicts the route record too.
    const routeWrites = writes.filter((w) => w.data.segments);
    expect(routeWrites.length).toBeGreaterThanOrEqual(2);
    const [miss, refreshed] = [routeWrites[0]!, routeWrites.at(-1)!];
    expect(recordOf(refreshed.data).tags).toContain("cached-data");
    expect(recordOf(refreshed.data).tags).toEqual(recordOf(miss.data).tags);
  });

  it("the refresh runs only the loader the handler reads", async () => {
    const clock = movableClock();
    const { store } = recordingStore();
    await serveShellRequest(router, "/page", { cacheStore: store });
    clock.advance(1_100);
    runs.pageData = 0;
    runs.sideData = 0;
    await serveShellRequest(router, "/page", { cacheStore: store });
    // The stale HIT runs both live; the refresh runs what its handler reads.
    expect(runs).toEqual({ pageData: 2, sideData: 1, cachedData: 0 });
  });
});

/**
 * A handler that awaits a loader which calls rendered() is the barrier
 * deadlock: every MISS refuses it (the read throws, and this handler catches
 * it and renders its fallback). The refresh must refuse it too. It renders
 * on a derived pass whose render barrier is the visitor's, already resolved:
 * with the visitor's guard bookkeeping inherited (closed), the read went
 * through, and rendered() read the visitor's handle snapshot into the record
 * or, on a tree that streams, waited on the refresh's own handle store,
 * which waits on the handler awaiting it: the refresh never settled.
 */
const Stamp = createHandle<string>();

const StampReader = createLoader(async (ctx) => {
  await ctx.rendered();
  return { read: `read:${ctx.get(Stamp).join(",")}` };
});

async function CatchingReader(ctx: HandlerContext): Promise<React.ReactNode> {
  ctx.use(Stamp)("stamp");
  try {
    const { read } = await ctx.use(StampReader);
    return <p>{`ok ${read}`}</p>;
  } catch {
    return <p>refused</p>;
  }
}

async function Reader(ctx: HandlerContext): Promise<React.ReactNode> {
  ctx.use(Stamp)("stamp");
  const { read } = await ctx.use(StampReader);
  return <p>{`ok ${read}`}</p>;
}

const barrierRouter = createRouter({}).routes(
  urls(({ path, cache, layout, loader, loading }) => [
    cache({ ttl: 0, swr: 60 }, () => [
      layout(<main>shell</main>, () => [
        path("/list", () => <ul>list</ul>, { name: "list" }),
        path("/catching", CatchingReader, { name: "catching" }, () => [
          loader(StampReader),
        ]),
        path(
          "/catching-streamed",
          CatchingReader,
          { name: "catchingStreamed" },
          () => [loader(StampReader), loading(<p>loading</p>)],
        ),
        path("/streamed", Reader, { name: "streamed" }, () => [
          loader(StampReader),
          loading(<p>loading</p>),
        ]),
      ]),
    ]),
  ]),
);

/** Rejects instead of waiting on a request that never settles. */
function bounded<T>(work: Promise<T>, ms = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function heldAtList(): Promise<ServeShellRequestOptions["partial"]> {
  const list = await serveShellRequest(barrierRouter, "/list", {
    cacheStore: new VercelCacheStore({ cache: vercelCache() }),
    partial: true,
  });
  return { from: "/list", segments: await matchedOf(list) };
}

describe("cache() route whose handler awaits a loader that calls rendered()", () => {
  beforeEach(async () => {
    await resetShellTestState();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const url of ["/catching", "/catching-streamed"]) {
    for (const held of [false, true]) {
      it(`${url}, ${held ? "navigation, layout held" : "document"}: every request renders the refusal, the refresh included`, async () => {
        const clock = movableClock();
        const { store } = recordingStore();
        const partial = held ? await heldAtList() : undefined;
        const shown: string[][] = [];
        for (let i = 0; i < 4; i++) {
          const { flight } = await bounded(
            serveShellRequest(barrierRouter, url, {
              cacheStore: store,
              partial,
            }),
          );
          shown.push(flight?.match(/refused|ok read:[^"]*/g) ?? []);
          clock.advance(1_100);
        }
        expect(shown).toEqual([
          ["refused"],
          ["refused"],
          ["refused"],
          ["refused"],
        ]);
      }, 30_000);
    }
  }

  it("/streamed, navigation, layout held: the re-render that writes the record settles", async () => {
    const clock = movableClock();
    const { store, writes } = recordingStore();
    const partial = await heldAtList();
    for (let i = 0; i < 3; i++) {
      await bounded(
        serveShellRequest(barrierRouter, "/streamed", {
          cacheStore: store,
          partial,
        }),
      );
      clock.advance(1_100);
    }
    // A MISS fails the handler: nothing is written.
    expect(writes).toEqual([]);
  }, 30_000);
});
