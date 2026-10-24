/**
 * An intercept open over a route under cache({ ttl, swr }): the background
 * re-render that writes its record (background-revalidation.ts
 * rerenderAndCacheRoute, for the stale-HIT refresh and for proactive caching)
 * runs only the intercept loaders its handler reads.
 *
 * A record never holds a loader's value or its pushes (cacheRoute drops
 * loader segments, captureHandles loader pushes), and every HIT runs the
 * intercept's loaders live. The re-render used to run them all anyway, so a
 * loader nobody read ran once more per refresh, its side effects and onError
 * reports included. It now skips them as it skips the route's: each is
 * registered, and a handler's read starts it as its DSL declaration, so its
 * pushes stay out of the record and every HIT shows them once.
 *
 * The re-render skips the intercepted route's own entry, as the MISS does.
 * It used to run that route's handler and store its segment and cacheTag()s
 * in the intercept record, so every HIT sent the route's page, in a `diff`
 * its `matched` did not always list.
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

/** The real clock, moved forward by hand until restored. */
function movableClock(): {
  advance: (ms: number) => void;
  restore: () => void;
} {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  const spy = vi
    .spyOn(Date, "now")
    .mockImplementation(() => realNow() + offset);
  return { advance: (ms) => (offset += ms), restore: () => spy.mockRestore() };
}

const Breadcrumbs = createHandle<string, string[]>((segments) =>
  segments.flat(),
);

const runs = { unread: 0, read: 0, target: 0 };

/** Declared by the intercept and read by nothing. */
const UnreadData = createLoader(async (ctx) => {
  runs.unread += 1;
  ctx.use(Breadcrumbs)("unread-data-crumb");
  cacheTag("unread-data");
  return { unread: true };
});

/** Declared by the intercept and read by its handler. */
const ReadData = createLoader(async (ctx) => {
  runs.read += 1;
  ctx.use(Breadcrumbs)("read-data-crumb");
  cacheTag("read-data");
  return { title: "read-value" };
});

/** Declared by an intercept, read by nothing, and always failing. */
const FailingData = createLoader(async () => {
  throw new Error("failing-data");
});

/** Every onError report, as `phase:message`. */
const reported: string[] = [];

function Layout(ctx: HandlerContext): React.ReactNode {
  ctx.use(Breadcrumbs)("layout-crumb");
  return <main>shell</main>;
}

async function ReadModal(ctx: HandlerContext): Promise<React.ReactNode> {
  ctx.use(Breadcrumbs)("modal-crumb");
  cacheTag("modal");
  const { title } = await ctx.use(ReadData);
  return <dialog>{title}</dialog>;
}

/** The page an intercept opens over /list, as a document renders it. */
function TargetPage(ctx: HandlerContext<{ id: string }>): React.ReactNode {
  runs.target += 1;
  ctx.use(Breadcrumbs)("target-page-crumb");
  cacheTag("target-page");
  return <article>target page</article>;
}

function TargetModal(ctx: HandlerContext): React.ReactNode {
  ctx.use(Breadcrumbs)("target-modal-crumb");
  cacheTag("target-modal");
  return <dialog>target modal</dialog>;
}

/** The routes, with or without the loader nobody reads. */
function routesWith(unreadLoader: boolean) {
  return urls(({ path, cache, layout, intercept, loader }) => [
    cache({ ttl: 0, swr: 60 }, () => [
      layout(Layout, () => [
        path("/list", () => <ul>list</ul>, { name: "list" }),
        path("/unread/:id", () => <article>unread</article>, {
          name: "unread",
        }),
        path("/read/:id", () => <article>read</article>, { name: "read" }),
        intercept(
          "@modal",
          ".unread",
          () => <dialog>unread modal</dialog>,
          () => (unreadLoader ? [loader(UnreadData)] : []),
        ),
        intercept("@modal", ".read", ReadModal, () => [loader(ReadData)]),
        path("/failing/:id", () => <article>failing</article>, {
          name: "failing",
        }),
        intercept(
          "@modal",
          ".failing",
          () => <dialog>failing modal</dialog>,
          () => [loader(FailingData)],
        ),
        path("/target/:id", TargetPage, { name: "target" }),
        intercept("@modal", ".target", TargetModal),
      ]),
    ]),
  ]);
}

const router = createRouter({
  onError: ({ phase, error }) => {
    reported.push(`${phase}:${error instanceof Error ? error.message : ""}`);
  },
}).routes(routesWith(true));
/** The same tree, its unread intercept declaring no loader. */
const noLoaderRouter = createRouter({}).routes(routesWith(false));

type Router = typeof router;
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
async function recordOf(data: any) {
  return {
    segments: data.segments.map((s: any) => ({
      ...s.metadata,
      encoded: s.encoded,
      layout: s.encodedLayout,
      loading: s.encodedLoading,
    })),
    handles: data.handles
      ? await deserializeResult<HandleData>(data.handles)
      : data.handles,
    handleOwners: data.handleOwners,
    tags: data.tags ? [...data.tags].sort() : data.tags,
  };
}

/**
 * How the client opens the modal over /list, and the handles it shows
 * before. Holding nothing, the MISS writes its own render; holding the
 * layout, a re-render writes it (proactive caching).
 */
type Shape = "nothing held" | "layout held";

const SHAPES: readonly Shape[] = ["nothing held", "layout held"];

async function visitOf(
  shape: Shape,
  over: Router = router,
): Promise<{
  partial: ServeShellRequestOptions["partial"];
  before: HandleData;
}> {
  if (shape === "nothing held") {
    return { partial: { from: "/list", segments: [] }, before: {} };
  }
  const list = await serveShellRequest(over, "/list", {
    cacheStore: new VercelCacheStore({ cache: vercelCache() }),
    partial: true,
  });
  return {
    partial: { from: "/list", segments: await matchedOf(list) },
    before: await handlesOf(list),
  };
}

/** The MISS, the stale HIT that refreshes the record, and the next HIT. */
async function missStaleHit(
  url: string,
  shape: Shape,
  over: Router = router,
): Promise<{
  results: ServeShellRequestResult[];
  runs: { unread: number; read: number; target: number }[];
  /** The onError reports of each request, its background work included. */
  reports: string[][];
  writes: StoreWrite[];
  before: HandleData;
}> {
  const clock = movableClock();
  const { store, writes } = recordingStore();
  const { partial, before } = await visitOf(shape, over);
  const results: ServeShellRequestResult[] = [];
  const counted: { unread: number; read: number; target: number }[] = [];
  const reports: string[][] = [];
  for (let i = 0; i < 3; i++) {
    runs.unread = 0;
    runs.read = 0;
    runs.target = 0;
    reported.length = 0;
    results.push(
      await serveShellRequest(over, url, { cacheStore: store, partial }),
    );
    counted.push({ ...runs });
    reports.push([...reported]);
    clock.advance(1_100);
  }
  clock.restore();
  return { results, runs: counted, reports, writes, before };
}

describe("cache() route with an intercept open: the background re-render", () => {
  beforeEach(async () => {
    await resetShellTestState();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const shape of SHAPES) {
    describe(shape, () => {
      it("runs no intercept loader its handler does not read", async () => {
        const { runs: counted } = await missStaleHit("/unread/1", shape);
        // One run per request, the visitor's: the MISS, the stale HIT whose
        // refresh runs none, and the HIT.
        expect(counted.map((c) => c.unread)).toEqual([1, 1, 1]);
      });

      it("reports a failing intercept loader nothing reads to onError once per request", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const { reports } = await missStaleHit("/failing/1", shape);
        expect(reports).toEqual([
          ["loader:failing-data"],
          ["loader:failing-data"],
          ["loader:failing-data"],
        ]);
      });

      it("writes the record it writes for the intercept without that loader", async () => {
        const { writes } = await missStaleHit("/unread/1", shape);
        const reference = await missStaleHit(
          "/unread/1",
          shape,
          noLoaderRouter,
        );
        expect(writes).toHaveLength(2);
        expect(reference.writes).toHaveLength(2);
        // No value, push or tag of the loader reaches either write.
        for (let i = 0; i < 2; i++) {
          expect(await recordOf(writes[i]!.data)).toEqual(
            await recordOf(reference.writes[i]!.data),
          );
        }
      });

      it("shows the unread loader's crumb once on every request", async () => {
        const { results, before } = await missStaleHit("/unread/1", shape);
        for (const result of results) {
          expect((await crumbs(result, before)).sort()).toEqual([
            "layout-crumb",
            "unread-data-crumb",
          ]);
        }
      });

      it("runs a loader its handler reads, and every request shows its crumb once", async () => {
        const {
          results,
          runs: counted,
          before,
        } = await missStaleHit("/read/1", shape);
        for (const result of results) {
          expect((await crumbs(result, before)).sort()).toEqual([
            "layout-crumb",
            "modal-crumb",
            "read-data-crumb",
          ]);
          expect(result.flight).toContain("read-value");
        }
        // The stale HIT's refresh starts it through the handler's read.
        expect(counted.map((c) => c.read)).toEqual(
          shape === "nothing held" ? [1, 2, 1] : [2, 2, 1],
        );
      });

      it("the refresh of a handler that reads its loader writes the MISS's slot, handles and tags", async () => {
        const { writes } = await missStaleHit("/read/1", shape);
        expect(writes).toHaveLength(2);
        const [miss, refreshed] = [
          await recordOf(writes[0]!.data),
          await recordOf(writes[1]!.data),
        ];
        expect(refreshed).toEqual(miss);
        // The handler's push stays, the loader's never enters; the read
        // links the loader's tag to the slot.
        const slot = miss.segments.find((s: any) => s.id.endsWith(".@modal"));
        expect(refreshed.handles?.[slot.id]).toEqual({
          [Breadcrumbs.$$id]: ["modal-crumb"],
        });
        expect(refreshed.tags).toEqual(["modal", "read-data"]);
      });

      it("never runs the intercepted route's own handler", async () => {
        const { runs: counted, writes } = await missStaleHit(
          "/target/1",
          shape,
        );
        // The MISS, the stale HIT with its refresh, and the HIT.
        expect(counted.map((c) => c.target)).toEqual([0, 0, 0]);
        // The refresh ran: the MISS wrote the record, and the refresh again.
        expect(writes).toHaveLength(2);
      });

      it("writes the refreshed record as the MISS wrote it, without the intercepted route's segment", async () => {
        const { writes } = await missStaleHit("/target/1", shape);
        expect(writes).toHaveLength(2);
        const [miss, refreshed] = [
          await recordOf(writes[0]!.data),
          await recordOf(writes[1]!.data),
        ];
        expect(refreshed).toEqual(miss);
        expect(miss.segments.filter((s: any) => s.type === "route")).toEqual(
          [],
        );
        expect(miss.tags).toEqual(["target-modal"]);
      });

      it("answers every HIT as the MISS answered, without the intercepted route's page", async () => {
        const { results } = await missStaleHit("/target/1", shape);
        const answers: { matched: string[]; diff: string[] }[] = [];
        for (const result of results) {
          const { matched, diff } = (
            await deserializeResult<any>(result.flight!)
          ).metadata;
          // Every segment the response sends is one it matched.
          expect(diff.filter((id: string) => !matched.includes(id))).toEqual(
            [],
          );
          expect(result.flight).not.toContain("target page");
          answers.push({ matched, diff });
        }
        expect(answers[1]).toEqual(answers[0]);
        expect(answers[2]).toEqual(answers[0]);
      });
    });
  }
});
