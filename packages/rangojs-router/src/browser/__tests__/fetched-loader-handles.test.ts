import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventController } from "../event-controller.js";
import { createNavigationStore } from "../navigation-store.js";
import {
  applyLateHandles,
  startFetchedLoaderRead,
  type FetchedLoaderHandles,
  type FetchedLoaderPage,
  type FetchedLoaderPushedBy,
} from "../fetched-loader-handles.js";
import { reconcileSegments } from "../segment-reconciler.js";
import { pushedByKey } from "../../handles/pushed-by.js";
import type { HandleData, ResolvedSegment } from "../types.js";

// A layout L0 and its route R0, which registers loader "title". The page's
// render filed the loader's pushes under R0, after the route handler's.
const matched = ["L0", "R0D0.title", "R0"];
const rendered = (): HandleData => ({
  Meta: { L0: [{ title: "Site" }], R0: [{ title: "Old" }] },
  [pushedByKey("Meta")]: { R0: ["title"] },
  Crumbs: { L0: ["Home"], R0: ["Page", "Old crumb"] },
  [pushedByKey("Crumbs")]: { R0: [null, "title"] },
});

const segment = (
  id: string,
  type: ResolvedSegment["type"],
  extra: Partial<ResolvedSegment> = {},
): ResolvedSegment => ({
  id,
  namespace: "",
  type,
  index: 0,
  component: null,
  ...extra,
});

/** The data the server sent for loader "title" on the page's visit. */
const routeData = { name: "one" };

/** The page's segments, one loader segment per id in `ids` of `matched`. */
const segmentsOf = (
  ids: readonly string[] = matched,
  data: Record<string, unknown> = { title: routeData },
): ResolvedSegment[] =>
  ids.map((id) => {
    const marker = /D\d+\./.exec(id);
    if (!marker) return segment(id, id.startsWith("R") ? "route" : "layout");
    const loaderId = id.slice(marker.index + marker[0].length);
    return segment(id, "loader", { loaderId, loaderData: data[loaderId] });
  });

function mountPage(
  ids: readonly string[] = matched,
  data?: Record<string, unknown>,
): FetchedLoaderPage {
  const eventController = createEventController({
    initialLocation: new URL("http://localhost/chat"),
  });
  const store = createNavigationStore({
    initialLocation: new URL("http://localhost/chat"),
  });
  store.setHistoryKey("/chat");
  store.cacheSegmentsForHistory("/chat", segmentsOf(ids, data), rendered());
  eventController.setHandleData(rendered(), [...ids]);
  return { eventController, store };
}

/**
 * Send a page read of `loaderId` into `bucketKey`, as use-loader.tsx does;
 * the returned function commits the reply to the loader store, then lands it.
 */
function sendRead(
  page: FetchedLoaderPage,
  loaderId: string,
  bucketKey: string = loaderId,
) {
  const loaders = page.store.loaders;
  // A reader with route context reads the bucket (use-loader.tsx).
  if (!loaders.hasRouteReaders(bucketKey)) {
    loaders.subscribe(bucketKey, () => {}, {
      loaderId,
      routeData: () => routeData,
    });
  }
  const requestId = loaders.reserveRequestId(bucketKey);
  loaders.beginRequest(bucketKey, requestId);
  const land = startFetchedLoaderRead(loaderId, page, {
    bucketKey,
    requestId,
  });
  return (
    handles: FetchedLoaderHandles | undefined,
    pushedBy?: FetchedLoaderPushedBy,
    result: unknown = { name: "renamed" },
  ): unknown => {
    loaders.finishData(bucketKey, requestId, result);
    land(result, handles, pushedBy);
    return result;
  };
}

/** What the entry of `key` holds for loader `loaderId`. */
const entryData = (
  page: FetchedLoaderPage,
  key: string,
  loaderId = "title",
): unknown[] | undefined =>
  page.store
    .getCachedSegments(key)
    ?.segments.filter((s) => s.loaderId === loaderId)
    .map((s) => s.loaderData);

const liveMeta = (page: FetchedLoaderPage) =>
  page.eventController.getHandleState().data.Meta;
const entryMeta = (page: FetchedLoaderPage, key = "/chat") =>
  page.store.getCachedSegments(key)?.handleData?.Meta;

/** Leave the page for /next, as a navigation commit does. */
function leaveTo(page: FetchedLoaderPage, key = "/next"): void {
  page.store.updateCacheHandleData(
    "/chat",
    page.eventController.getHandleState().data,
  );
  page.store.cacheSegmentsForHistory(key, [segment("R1", "route")], {});
  page.store.setHistoryKey(key);
  page.eventController.setHandleData({ Meta: { R1: [{ title: "Next" }] } }, [
    "R1",
  ]);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startFetchedLoaderRead", () => {
  it("replaces the loader's values in its segment and keeps the entry's copy", async () => {
    const page = mountPage();
    sendRead(
      page,
      "title",
    )({
      Meta: [{ title: "New" }],
      Crumbs: ["New crumb"],
    });
    await settle();
    const { data, segmentOrder } = page.eventController.getHandleState();
    expect(segmentOrder).toEqual(["L0", "R0"]);
    expect(data.Meta).toEqual({
      L0: [{ title: "Site" }],
      R0: [{ title: "New" }],
    });
    expect(data.Crumbs).toEqual({ L0: ["Home"], R0: ["Page", "New crumb"] });
    expect(entryMeta(page)).toEqual(data.Meta);
  });

  it("clears the loader's values when the read pushed nothing", async () => {
    const page = mountPage();
    sendRead(page, "title")({});
    await settle();
    const { data } = page.eventController.getHandleState();
    expect(data.Meta).toEqual({ L0: [{ title: "Site" }] });
    expect(data.Crumbs).toEqual({ L0: ["Home"], R0: ["Page"] });
  });

  it("applies a pending push once it settles, and drops a rejected one", async () => {
    const page = mountPage();
    let resolveTitle!: (value: unknown) => void;
    const rejected = Promise.reject(new Error("no crumb"));
    rejected.catch(() => {});
    sendRead(
      page,
      "title",
    )({
      Meta: [new Promise((resolve) => (resolveTitle = resolve))],
      Crumbs: [rejected],
    });
    await settle();
    // The data is not held for it; the handle keeps its value until then.
    expect(liveMeta(page).R0).toEqual([{ title: "Old" }]);
    resolveTitle({ title: "Late" });
    await settle();
    const { data } = page.eventController.getHandleState();
    expect(data.Meta.R0).toEqual([{ title: "Late" }]);
    expect(data.Crumbs.R0).toEqual(["Page"]);
  });

  it("leaves a value another loader on the page pushed to that loader, after a dropped pending one", async () => {
    const ids = ["L0", "R0D0.members", "R0D1.title", "R0"];
    const page = mountPage(ids, { members: {}, title: routeData });
    page.eventController.setHandleData(
      {
        Crumbs: { L0: ["Home"], R0: ["Members", "Old crumb"] },
        [pushedByKey("Crumbs")]: { R0: ["members", "title"] },
      },
      ids,
    );
    sendRead(page, "title")(
      { Crumbs: [Promise.resolve(null), "Members", "New crumb"] },
      { Crumbs: [null, "members", null] },
    );
    await settle();
    const { data } = page.eventController.getHandleState();
    expect(data.Crumbs).toEqual({
      L0: ["Home"],
      R0: ["Members", "New crumb"],
    });
    expect(data[pushedByKey("Crumbs")]).toEqual({ R0: ["members", "title"] });
  });

  it("applies the reads of a group refresh each to its own loader", async () => {
    const ids = ["L0", "L0D0.layoutCrumb", "R0D0.title", "R0"];
    const page = mountPage(ids, { layoutCrumb: {}, title: routeData });
    const title = sendRead(page, "title");
    const crumb = sendRead(page, "layoutCrumb");
    crumb({ Crumbs: ["Layout crumb"] });
    title({ Meta: [{ title: "New" }] });
    await settle();
    const { data } = page.eventController.getHandleState();
    expect(data.Meta.R0).toEqual([{ title: "New" }]);
    expect(data.Crumbs).toEqual({
      L0: ["Home", "Layout crumb"],
      R0: ["Page"],
    });
  });

  it("a landed read writes its data into the entry's loader segments, under every key of the page", async () => {
    const page = mountPage();
    // A shallow navigation's twin key shares the page's segments array.
    const segments = page.store.getCachedSegments("/chat")!.segments;
    page.store.cacheSegmentsForHistory("/chat?tab=2", segments, rendered());
    const result = sendRead(page, "title")({ Meta: [{ title: "New" }] });
    await settle();
    // The read's result object itself, in place in the shared array.
    expect(entryData(page, "/chat")).toEqual([result]);
    expect(entryData(page, "/chat")![0]).toBe(result);
    expect(page.store.getCachedSegments("/chat")!.segments).toBe(segments);
    expect(entryMeta(page, "/chat")?.R0).toEqual([{ title: "New" }]);
    expect(entryMeta(page, "/chat?tab=2")?.R0).toEqual([{ title: "New" }]);
    expect(page.store.getPageReadLoaders("/chat")).toEqual(new Set(["title"]));
  });

  it("writes the data of a read that pushed no handle values", () => {
    const page = mountPage();
    const result = sendRead(page, "title")(undefined);
    expect(entryData(page, "/chat")).toEqual([result]);
    expect(liveMeta(page).R0).toEqual([{ title: "Old" }]);
  });

  it("a read lands across an action that kept its loader", async () => {
    const page = mountPage();
    const apply = sendRead(page, "title");
    // An action commit that reconciled from the entry before the reply: a
    // new array, the loader's segment copied with its data.
    const before = page.store.getCachedSegments("/chat")!.segments;
    page.store.cacheSegmentsForHistory(
      "/chat",
      before.map((s) => ({ ...s })),
      rendered(),
    );
    const result = apply({ Meta: [{ title: "New" }] });
    await settle();
    expect(entryData(page, "/chat")).toEqual([result]);
    expect(liveMeta(page).R0).toEqual([{ title: "New" }]);
    expect(entryMeta(page)?.R0).toEqual([{ title: "New" }]);
  });

  it("a commit after the read landed that kept the loader's segment keeps the read's data", () => {
    const page = mountPage();
    const result = sendRead(page, "title")(undefined);
    // A commit that reconciled from the entry before the read landed writes
    // the segment the read replaced.
    page.store.cacheSegmentsForHistory("/chat", segmentsOf(), rendered());
    expect(entryData(page, "/chat")).toEqual([result]);
    expect(page.store.getPageReadLoaders("/chat")).toEqual(new Set(["title"]));
  });

  it("a commit that re-ran the loader ends the read: its data and its late values are the server's again", async () => {
    const page = mountPage();
    sendRead(page, "title")({ Meta: [{ title: "New" }] });
    await settle();
    const rerun = { name: "acted" };
    page.store.cacheSegmentsForHistory(
      "/chat",
      segmentsOf(matched, { title: rerun }),
      page.eventController.getHandleState().data,
    );
    expect(entryData(page, "/chat")).toEqual([rerun]);
    expect(page.store.getPageReadLoaders("/chat").size).toBe(0);
    // A late push now replaces the loader's run like any other.
    applyLateHandles(page, rendered(), matched, "/chat");
    expect(liveMeta(page).R0).toEqual([{ title: "Old" }]);
  });

  it("a read lands across a shallow navigation and is written to both keys", async () => {
    const page = mountPage();
    const apply = sendRead(page, "title");
    const segments = page.store.getCachedSegments("/chat")!.segments;
    page.store.cacheSegmentsForHistory("/chat?tab=2", segments, rendered());
    page.store.setHistoryKey("/chat?tab=2");
    const result = apply({ Meta: [{ title: "New" }] });
    await settle();
    expect(liveMeta(page).R0).toEqual([{ title: "New" }]);
    expect(entryData(page, "/chat")).toEqual([result]);
    expect(entryMeta(page, "/chat")?.R0).toEqual([{ title: "New" }]);
    expect(entryMeta(page, "/chat?tab=2")?.R0).toEqual([{ title: "New" }]);
  });

  it("a read lands across a shallow navigation and then an action on the new key, live and on both entries", async () => {
    const page = mountPage();
    const apply = sendRead(page, "title");
    const segments = page.store.getCachedSegments("/chat")!.segments;
    page.store.cacheSegmentsForHistory("/chat?tab=2", segments, rendered());
    page.store.setHistoryKey("/chat?tab=2");
    // An action on the new key writes a new array there, the loader's
    // segment kept; /chat keeps the array the read was sent from.
    page.store.cacheSegmentsForHistory(
      "/chat?tab=2",
      segments.map((s) => ({ ...s })),
      rendered(),
    );
    const result = apply({ Meta: [{ title: "New" }] });
    await settle();
    expect(page.store.loaders.getSnapshot("title").value).toBe(result);
    expect(liveMeta(page).R0).toEqual([{ title: "New" }]);
    expect(entryData(page, "/chat?tab=2")).toEqual([result]);
    expect(entryMeta(page, "/chat?tab=2")?.R0).toEqual([{ title: "New" }]);
    expect(entryData(page, "/chat")).toEqual([result]);
    expect(entryMeta(page, "/chat")?.R0).toEqual([{ title: "New" }]);
  });

  it("a read writes its data to every loader segment of the loader, each holding other data", async () => {
    const page = mountPage();
    // A layout's held copy of the loader beside the route's re-run copy:
    // the bucket's readers on both show the read's result.
    const held = { name: "held" };
    page.store.cacheSegmentsForHistory(
      "/chat",
      [
        segment("L0", "layout"),
        segment("L0D0.title", "loader", {
          loaderId: "title",
          loaderData: held,
        }),
        segment("R0D0.title", "loader", {
          loaderId: "title",
          loaderData: routeData,
        }),
        segment("R0", "route"),
      ],
      rendered(),
    );
    const result = sendRead(page, "title")({ Meta: [{ title: "New" }] });
    await settle();
    expect(entryData(page, "/chat")).toEqual([result, result]);
    expect(entryMeta(page)?.R0).toEqual([{ title: "New" }]);
    expect(liveMeta(page).R0).toEqual([{ title: "New" }]);
  });

  it("a read that replies after the page was left lands on its own entry only", async () => {
    const page = mountPage();
    const apply = sendRead(page, "title");
    leaveTo(page);
    const result = apply({ Meta: [{ title: "New" }] });
    await settle();
    expect(liveMeta(page)).toEqual({ R1: [{ title: "Next" }] });
    expect(entryData(page, "/chat")).toEqual([result]);
    expect(entryMeta(page)).toEqual({
      L0: [{ title: "Site" }],
      R0: [{ title: "New" }],
    });
  });

  it("lands nothing when the page committed again since the read was sent", async () => {
    const page = mountPage();
    const apply = sendRead(page, "title");
    // A new visit of the same URL: the server sent the loader's data anew.
    page.store.cacheSegmentsForHistory(
      "/chat",
      segmentsOf(matched, { title: { name: "again" } }),
      rendered(),
    );
    apply({ Meta: [{ title: "Stale" }] });
    await settle();
    expect(liveMeta(page).R0).toEqual([{ title: "Old" }]);
    expect(entryData(page, "/chat")).toEqual([{ name: "again" }]);
  });

  it("lands nothing for an older read of the same bucket, its data and its values together", async () => {
    const page = mountPage();
    const older = sendRead(page, "title");
    const newer = sendRead(page, "title");
    const result = newer({ Meta: [{ title: "Newer" }] });
    older({ Meta: [{ title: "Older" }] }, undefined, { name: "older" });
    await settle();
    expect(liveMeta(page).R0).toEqual([{ title: "Newer" }]);
    expect(entryData(page, "/chat")).toEqual([result]);
  });

  it("reads of one loader under two buckets each land; the last to land writes the title and the entry", async () => {
    const page = mountPage();
    const keyed = sendRead(page, "title", "title::a");
    const plain = sendRead(page, "title");
    plain({ Meta: [{ title: "Plain" }] }, undefined, { name: "plain" });
    keyed({ Meta: [{ title: "Keyed" }] }, undefined, { name: "keyed" });
    await settle();
    expect(page.store.loaders.getSnapshot("title").value).toEqual({
      name: "plain",
    });
    expect(page.store.loaders.getSnapshot("title::a").value).toEqual({
      name: "keyed",
    });
    expect(liveMeta(page).R0).toEqual([{ title: "Keyed" }]);
    expect(entryData(page, "/chat")).toEqual([{ name: "keyed" }]);
  });

  it("a read on another router of the page leaves this router's read current", async () => {
    const page = mountPage();
    const other = mountPage();
    const apply = sendRead(page, "title");
    // The same loader read on a second router, sent after this one.
    sendRead(other, "title")({ Meta: [{ title: "Other" }] });
    apply({ Meta: [{ title: "New" }] });
    await settle();
    expect(liveMeta(page).R0).toEqual([{ title: "New" }]);
    expect(liveMeta(other).R0).toEqual([{ title: "Other" }]);
  });

  it("pending pushes that settle after the page was left write its entry, and apply live once Back restored it", async () => {
    const page = mountPage();
    let resolveTitle!: (value: unknown) => void;
    const result = sendRead(
      page,
      "title",
    )({
      Meta: [new Promise((resolve) => (resolveTitle = resolve))],
    });
    // The data is written when it lands.
    expect(entryData(page, "/chat")).toEqual([result]);
    leaveTo(page);
    resolveTitle({ title: "Pending" });
    await settle();
    expect(entryMeta(page)?.R0).toEqual([{ title: "Pending" }]);
    expect(liveMeta(page)).toEqual({ R1: [{ title: "Next" }] });

    // Back restored the page before a second read's pushes settle.
    let resolveSecond!: (value: unknown) => void;
    page.store.setHistoryKey("/chat");
    page.eventController.setHandleData(
      page.store.getCachedSegments("/chat")!.handleData!,
      matched,
    );
    sendRead(
      page,
      "title",
    )({
      Meta: [new Promise((resolve) => (resolveSecond = resolve))],
    });
    resolveSecond({ title: "Second" });
    await settle();
    expect(liveMeta(page).R0).toEqual([{ title: "Second" }]);
    expect(entryMeta(page)?.R0).toEqual([{ title: "Second" }]);
  });

  it("a read inside an intercept writes the intercept's entry", async () => {
    const ids = ["L0", "R0", "R0.@modal", "R0.@modalD0.title"];
    const page = mountPage(ids);
    const key = "/item:intercept:/chat";
    page.store.cacheSegmentsForHistory(key, segmentsOf(ids), rendered());
    page.store.setHistoryKey(key);
    const result = sendRead(page, "title")({ Meta: [{ title: "New" }] });
    await settle();
    expect(entryData(page, key)).toEqual([result]);
    // The plain entry the intercept was opened over is another page.
    expect(entryData(page, "/chat")).toEqual([routeData]);
  });

  it("applies nothing for a loader no segment registers, and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const page = mountPage();
    const before = page.eventController.getHandleState().data;
    sendRead(page, "search")({ Meta: [{ title: "Search" }] });
    sendRead(page, "search")({ Meta: [{ title: "Search" }] });
    await settle();
    expect(page.eventController.getHandleState().data).toBe(before);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('Loader "search" pushed handle');
  });

  it("a read from outside the page's route tree changes no handle value, and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const page = mountPage();
    const before = page.eventController.getHandleState().data;
    // No bucket: the reader has no route context (use-loader.tsx).
    for (const n of [1, 2]) {
      startFetchedLoaderRead(
        "title",
        page,
        undefined,
      )({ name: `outside ${n}` }, { Meta: [{ title: "Outside" }] });
    }
    await settle();
    expect(page.eventController.getHandleState().data).toBe(before);
    expect(entryData(page, "/chat")).toEqual([routeData]);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain("outside the page's route tree");
    expect(message).toContain("useRouter().refresh()");
    expect(message).not.toContain("usePushHandle");
  });

  it("a read into a bucket only readers outside the route tree read stays off the page; one a route reader shares is the page's", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const page = mountPage();
    const loaders = page.store.loaders;
    const send = (bucketKey: string, name: string) => {
      const requestId = loaders.reserveRequestId(bucketKey);
      loaders.beginRequest(bucketKey, requestId);
      const land = startFetchedLoaderRead("title", page, {
        bucketKey,
        requestId,
      });
      loaders.finishData(bucketKey, requestId, { name });
      land({ name }, { Meta: [{ title: name }] });
    };
    // A keyed useFetchLoader outside the route tree, alone on its bucket.
    loaders.subscribe("title::outside", () => {}, {
      loaderId: "title",
      ephemeral: true,
    });
    send("title::outside", "Outside");
    await settle();
    expect(liveMeta(page).R0).toEqual([{ title: "Old" }]);
    expect(entryData(page, "/chat")).toEqual([routeData]);
    // The same key read by a reader inside the route: the data shows there.
    loaders.subscribe("title::outside", () => {}, {
      loaderId: "title",
      routeData: () => routeData,
    });
    send("title::outside", "Shared");
    await settle();
    expect(liveMeta(page).R0).toEqual([{ title: "Shared" }]);
    expect(entryData(page, "/chat")).toEqual([{ name: "Shared" }]);
  });

  it("waits for the hydration window like any handle write, and the entry takes the data with the values", async () => {
    const page = mountPage();
    page.eventController.lockHydration();
    const result = sendRead(page, "title")({ Meta: [{ title: "New" }] });
    await settle();
    expect(liveMeta(page).R0).toEqual([{ title: "Old" }]);
    expect(entryData(page, "/chat")).toEqual([routeData]);
    page.eventController.releaseHydrationLock();
    expect(liveMeta(page).R0).toEqual([{ title: "New" }]);
    // The history entry keeps the data and values the read applied, for Back.
    expect(entryData(page, "/chat")).toEqual([result]);
    expect(entryMeta(page)?.R0).toEqual([{ title: "New" }]);
  });

  it("a read applied after the hydration window, behind a navigation that waited, keeps its entry's copy and leaves the new page's", async () => {
    const page = mountPage();
    page.eventController.lockHydration();
    sendRead(page, "title")({ Meta: [{ title: "New" }] });
    await settle();
    // A navigation's handle write waits behind the read's.
    page.eventController.setHandleData(
      { Meta: { L0: [{ title: "Site" }], R1: [{ title: "Next" }] } },
      ["L0", "R1"],
    );
    page.eventController.releaseHydrationLock();
    expect(liveMeta(page)).toEqual({
      L0: [{ title: "Site" }],
      R1: [{ title: "Next" }],
    });
    expect(entryMeta(page)?.R0).toEqual([{ title: "New" }]);
  });

  it("does nothing without a router", async () => {
    const page = mountPage();
    const before = page.eventController.getHandleState().data;
    startFetchedLoaderRead("title", undefined, {
      bucketKey: "title",
      requestId: 1,
    })({ name: "x" }, { Meta: [{ title: "New" }] });
    await settle();
    expect(page.eventController.getHandleState().data).toBe(before);
  });
});

describe("the page's read record across entry writes", () => {
  it("a commit that keeps the loader's segment keeps its data by identity (reconcileSegments)", () => {
    const cached = segmentsOf();
    const { segments } = reconcileSegments({
      actor: "action",
      matched,
      diff: ["R0"],
      serverSegments: [segment("R0", "route")],
      cachedSegments: cached,
    });
    const loader = segments.find((s) => s.loaderId === "title");
    expect(loader?.loaderData).toBe(routeData);
  });

  it("a commit that reconciled between two reads keeps the newer one", () => {
    const page = mountPage();
    sendRead(page, "title")(undefined, undefined, { name: "first" });
    // A commit that reconciled from the entry after the first read landed.
    const reconciled = page.store
      .getCachedSegments("/chat")!
      .segments.map((s) => ({ ...s }));
    const second = sendRead(page, "title")(undefined, undefined, {
      name: "second",
    });
    page.store.cacheSegmentsForHistory("/chat", reconciled, rendered());
    expect(entryData(page, "/chat")).toEqual([second]);
  });

  it("a commit that reconciled after one read and wrote after two more keeps the newest", async () => {
    const page = mountPage();
    sendRead(page, "title")(undefined, undefined, { name: "r1" });
    // The commit reconciles from the entry (holding r1), then renders.
    const reconciled = page.store
      .getCachedSegments("/chat")!
      .segments.map((s) => ({ ...s }));
    sendRead(page, "title")(undefined, undefined, { name: "r2" });
    const r3 = sendRead(page, "title")({ Meta: [{ title: "R3" }] }, undefined, {
      name: "r3",
    });
    await settle();
    // It writes once rendered, with the live handle state.
    page.store.cacheSegmentsForHistory(
      "/chat",
      reconciled,
      page.eventController.getHandleState().data,
    );
    expect(entryData(page, "/chat")).toEqual([r3]);
    expect(entryMeta(page)?.R0).toEqual([{ title: "R3" }]);
    expect(page.store.getPageReadLoaders("/chat")).toEqual(new Set(["title"]));
  });

  it("a fill's splice keeps a read that landed while the answer rendered", () => {
    const page = mountPage();
    const live = page.store.getCachedSegments("/chat")!.segments;
    // The fill reconciled from the entry before the read landed.
    const reconciled = live.map((s) => ({ ...s }));
    const result = sendRead(page, "title")(undefined);
    page.store.replaceEntrySegments(live, reconciled);
    expect(page.store.getCachedSegments("/chat")!.segments).toBe(live);
    expect(entryData(page, "/chat")).toEqual([result]);
  });
});

// A later tree hands a landed read's result to the loader's readers as its
// data. While only its own page's entries hold it, only that page's trees can
// (LoaderStore.readPage): an entry of another page holding it makes it shared.
describe("the page a landed read's result is exclusive to", () => {
  const readPage = (page: FetchedLoaderPage, result: unknown) =>
    page.store.loaders.readPage(result);

  it("is the page the read was sent from, the one its bucket's request is of", () => {
    const page = mountPage();
    const result = sendRead(page, "title")(undefined);
    expect(page.store.loaders.isReadResult(result)).toBe(true);
    expect(readPage(page, result)).toBeDefined();
    expect(readPage(page, result)).toBe(
      page.store.loaders.getSnapshot("title").page,
    );
  });

  it("is shared once an entry of another page holds it: a navigation that kept the loader", () => {
    const page = mountPage();
    const result = sendRead(page, "title")(undefined);
    const kept = page.store.getCachedSegments("/chat")!.segments;
    page.store.cacheSegmentsForHistory("/next", [...kept], rendered());
    expect(entryData(page, "/next")).toEqual([result]);
    expect(readPage(page, result)).toBeUndefined();
    // For good: the page it landed on does not get it back.
    page.store.setHistoryKey("/next");
    page.store.setHistoryKey("/chat");
    page.store.cacheSegmentsForHistory(
      "/chat",
      kept.map((s) => ({ ...s })),
      rendered(),
    );
    expect(readPage(page, result)).toBeUndefined();
  });

  it("stays the page's across an action's write under the same key", () => {
    const page = mountPage();
    const result = sendRead(page, "title")(undefined);
    const before = readPage(page, result);
    const live = page.store.getCachedSegments("/chat")!.segments;
    page.store.cacheSegmentsForHistory(
      "/chat",
      live.map((s) => ({ ...s })),
      rendered(),
    );
    expect(entryData(page, "/chat")).toEqual([result]);
    expect(readPage(page, result)).toBe(before);
  });

  it("stays the page's across a shallow navigation's twin key, and an action on it", () => {
    const page = mountPage();
    const result = sendRead(page, "title")(undefined);
    const before = readPage(page, result);
    const segments = page.store.getCachedSegments("/chat")!.segments;
    page.store.cacheSegmentsForHistory("/chat?tab=2", segments, rendered());
    page.store.setHistoryKey("/chat?tab=2");
    expect(readPage(page, result)).toBe(before);
    page.store.cacheSegmentsForHistory(
      "/chat?tab=2",
      segments.map((s) => ({ ...s })),
      rendered(),
    );
    expect(entryData(page, "/chat?tab=2")).toEqual([result]);
    expect(readPage(page, result)).toBe(before);
  });

  it("a read sent from the next page is that page's, beside a shared one", () => {
    const page = mountPage();
    const onChat = sendRead(page, "title")(undefined, undefined, {
      name: "on chat",
    });
    const kept = page.store.getCachedSegments("/chat")!.segments;
    page.store.cacheSegmentsForHistory("/next", [...kept], rendered());
    page.store.setHistoryKey("/next");
    const onNext = sendRead(page, "title")(undefined, undefined, {
      name: "on next",
    });
    expect(entryData(page, "/next")).toEqual([onNext]);
    expect(entryData(page, "/chat")).toEqual([onChat]);
    expect(readPage(page, onChat)).toBeUndefined();
    expect(readPage(page, onNext)).toBeDefined();
    expect(readPage(page, onNext)).toBe(
      page.store.loaders.getSnapshot("title").page,
    );
  });
});

describe("applyLateHandles", () => {
  // The document's late yield: the layout's late value beside the
  // document's own run of "title".
  const late = (): HandleData => ({
    Meta: {
      L0: [{ title: "Site" }, { title: "Late" }],
      R0: [{ title: "Old" }],
    },
    [pushedByKey("Meta")]: { R0: ["title"] },
  });
  const merged = {
    L0: [{ title: "Site" }, { title: "Late" }],
    R0: [{ title: "New" }],
  };

  it("swaps the yield in whole when no read landed, and writes the entry from it", () => {
    const page = mountPage();
    applyLateHandles(page, late(), matched, "/chat");
    expect(page.eventController.getHandleState().data).toEqual(late());
    expect(page.store.getCachedSegments("/chat")?.handleData).toEqual(late());
  });

  it("outside the hydration window: a read, then a late push, keeps the read's values", async () => {
    const page = mountPage();
    sendRead(page, "title")({ Meta: [{ title: "New" }] });
    await settle();
    applyLateHandles(page, late(), matched, "/chat");
    expect(liveMeta(page)).toEqual(merged);
    expect(entryMeta(page)).toEqual(merged);
  });

  it("a read then a late push during the window: live and entry agree once it closes", async () => {
    const page = mountPage();
    page.eventController.lockHydration();
    sendRead(page, "title")({ Meta: [{ title: "New" }] });
    await settle();
    applyLateHandles(page, late(), matched, "/chat");
    // Both live writes wait in the window; the entry takes the late push at
    // once (a commit made meanwhile reads the page from it), the read's data
    // and values when they apply.
    expect(entryMeta(page)).toEqual(late().Meta);
    expect(liveMeta(page)).toEqual(rendered().Meta);
    page.eventController.releaseHydrationLock();
    expect(liveMeta(page)).toEqual(merged);
    expect(entryMeta(page)).toEqual(merged);
  });

  it("off screen: the entry takes the push through the same merge", async () => {
    const page = mountPage();
    sendRead(page, "title")({ Meta: [{ title: "New" }] });
    await settle();
    leaveTo(page);
    applyLateHandles(page, late(), matched, "/chat");
    expect(entryMeta(page)).toEqual(merged);
    expect(liveMeta(page)).toEqual({ R1: [{ title: "Next" }] });
  });
});
