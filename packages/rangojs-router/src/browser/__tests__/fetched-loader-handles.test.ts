import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventController } from "../event-controller.js";
import { createNavigationStore } from "../navigation-store.js";
import { startFetchedLoaderRead } from "../fetched-loader-handles.js";
import { pushedByKey } from "../../handles/pushed-by.js";
import type { HandleData } from "../types.js";

// A layout L0 and its route R0, which registers loader "title". The page's
// render filed the loader's pushes under R0, after the route handler's.
const matched = ["L0", "R0D0.title", "R0"];
const rendered = (): HandleData => ({
  Meta: { L0: [{ title: "Site" }], R0: [{ title: "Old" }] },
  [pushedByKey("Meta")]: { R0: ["title"] },
  Crumbs: { L0: ["Home"], R0: ["Page", "Old crumb"] },
  [pushedByKey("Crumbs")]: { R0: [null, "title"] },
});

function mountPage() {
  const eventController = createEventController({
    initialLocation: new URL("http://localhost/chat"),
  });
  const store = createNavigationStore({
    initialLocation: new URL("http://localhost/chat"),
  });
  store.setHistoryKey("/chat");
  store.cacheSegmentsForHistory("/chat", [], rendered());
  eventController.setHandleData(rendered(), matched);
  return { eventController, store };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startFetchedLoaderRead", () => {
  it("replaces the loader's values in its segment and keeps the entry's copy", async () => {
    const page = mountPage();
    startFetchedLoaderRead(
      "title",
      page,
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
    expect(page.store.getCachedSegments("/chat")?.handleData?.Meta).toEqual(
      data.Meta,
    );
  });

  it("clears the loader's values when the read pushed nothing", async () => {
    const page = mountPage();
    startFetchedLoaderRead("title", page)({});
    await settle();
    const { data } = page.eventController.getHandleState();
    expect(data.Meta).toEqual({ L0: [{ title: "Site" }] });
    expect(data.Crumbs).toEqual({ L0: ["Home"], R0: ["Page"] });
  });

  it("applies a pending push once it settles, and drops a rejected one", async () => {
    const page = mountPage();
    let resolveTitle!: (value: unknown) => void;
    startFetchedLoaderRead(
      "title",
      page,
    )({
      Meta: [new Promise((resolve) => (resolveTitle = resolve))],
      Crumbs: [Promise.reject(new Error("no crumb"))],
    });
    await settle();
    // The data is not held for it; the handle keeps its value until then.
    expect(page.eventController.getHandleState().data.Meta.R0).toEqual([
      { title: "Old" },
    ]);
    resolveTitle({ title: "Late" });
    await settle();
    const { data } = page.eventController.getHandleState();
    expect(data.Meta.R0).toEqual([{ title: "Late" }]);
    expect(data.Crumbs.R0).toEqual(["Page"]);
  });

  it("applies the reads of a group refresh each to its own loader", async () => {
    const page = mountPage();
    page.eventController.setHandleData(rendered(), [
      "L0",
      "L0D0.layoutCrumb",
      "R0D0.title",
      "R0",
    ]);
    const title = startFetchedLoaderRead("title", page);
    const crumb = startFetchedLoaderRead("layoutCrumb", page);
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

  it("leaves the handles when the page committed again since the read was sent", async () => {
    const page = mountPage();
    const apply = startFetchedLoaderRead("title", page);
    // A navigation back to the same URL: a new visit of the entry.
    page.store.cacheSegmentsForHistory("/chat", [], rendered());
    apply({ Meta: [{ title: "Stale" }] });
    await settle();
    expect(page.eventController.getHandleState().data.Meta.R0).toEqual([
      { title: "Old" },
    ]);
  });

  it("leaves the handles to a newer read of the same loader", async () => {
    const page = mountPage();
    const older = startFetchedLoaderRead("title", page);
    const newer = startFetchedLoaderRead("title", page);
    newer({ Meta: [{ title: "Newer" }] });
    older({ Meta: [{ title: "Older" }] });
    await settle();
    expect(page.eventController.getHandleState().data.Meta.R0).toEqual([
      { title: "Newer" },
    ]);
  });

  it("applies nothing for a loader no segment registers, and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const page = mountPage();
    const before = page.eventController.getHandleState().data;
    startFetchedLoaderRead("search", page)({ Meta: [{ title: "Search" }] });
    startFetchedLoaderRead("search", page)({ Meta: [{ title: "Search" }] });
    await settle();
    expect(page.eventController.getHandleState().data).toBe(before);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('Loader "search" pushed handle');
  });

  it("waits for the hydration window like any handle write", async () => {
    const page = mountPage();
    page.eventController.lockHydration();
    startFetchedLoaderRead("title", page)({ Meta: [{ title: "New" }] });
    await settle();
    expect(page.eventController.getHandleState().data.Meta.R0).toEqual([
      { title: "Old" },
    ]);
    page.eventController.releaseHydrationLock();
    expect(page.eventController.getHandleState().data.Meta.R0).toEqual([
      { title: "New" },
    ]);
  });

  it("does nothing without a router, or for a reply without handles", async () => {
    const page = mountPage();
    const before = page.eventController.getHandleState().data;
    startFetchedLoaderRead("title", undefined)({ Meta: [{ title: "New" }] });
    startFetchedLoaderRead("title", page)(undefined);
    await settle();
    expect(page.eventController.getHandleState().data).toBe(before);
  });
});
