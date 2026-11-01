import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NavigationStore } from "../browser/types.js";
import { makeJar } from "./cookie-jar-mock.js";

const NAME = "rango-state_router_0";

function fakeStore(): NavigationStore {
  return {
    markHistoryCacheStale: vi.fn(),
    markCachesStaleAfterWrite: vi.fn(),
  } as unknown as NavigationStore;
}

describe("navigation-store-handle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("location", { protocol: "http:" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns null before a store is registered", async () => {
    const { getRegisteredStore } =
      await import("../browser/navigation-store-handle");
    expect(getRegisteredStore()).toBeNull();
  });

  it("returns the registered store", async () => {
    const { registerNavigationStore, getRegisteredStore } =
      await import("../browser/navigation-store-handle");
    const store = fakeStore();
    registerNavigationStore(store);
    expect(getRegisteredStore()).toBe(store);
  });

  it("marks history stale once on an external rotation, without re-rotating", async () => {
    const j = makeJar({ [NAME]: "v1:100" });
    vi.stubGlobal("document", j.jar);

    const { initRangoState, getRangoState } =
      await import("../browser/rango-state");
    const { registerNavigationStore } =
      await import("../browser/navigation-store-handle");

    initRangoState("v1", NAME);
    const store = fakeStore();
    registerNavigationStore(store);

    // A sibling tab / server Set-Cookie rotated the shared cookie.
    j.set(NAME, "v1:200");
    expect(getRangoState()).toBe("v1:200");
    // No ping-pong: the value is adopted, never re-rotated.
    expect(getRangoState()).toBe("v1:200");
    expect(getRangoState()).toBe("v1:200");

    expect(store.markHistoryCacheStale).toHaveBeenCalledTimes(1);
    expect(store.markCachesStaleAfterWrite).not.toHaveBeenCalled();
  });

  it("marks history and prefetches stale once when a read sees another write", async () => {
    const j = makeJar({ [NAME]: "v1:100" });
    vi.stubGlobal("document", j.jar);

    const { initRangoState, getRangoState } =
      await import("../browser/rango-state");
    const { registerNavigationStore } =
      await import("../browser/navigation-store-handle");

    initRangoState("v1", NAME);
    const store = fakeStore();
    registerNavigationStore(store);

    // A server action's response, in this tab or another, bumped the write
    // part in the shared jar; no broadcast reached this tab.
    j.set(NAME, "v1:100:5000");
    expect(getRangoState()).toBe("v1:100:5000");
    expect(getRangoState()).toBe("v1:100:5000");

    expect(store.markCachesStaleAfterWrite).toHaveBeenCalledTimes(1);
    expect(store.markHistoryCacheStale).not.toHaveBeenCalled();
  });

  it("holds a write seen while an action is in flight until the fence drops, when no landing took it", async () => {
    const j = makeJar({ [NAME]: "v1:100" });
    vi.stubGlobal("document", j.jar);

    const { initRangoState, getRangoState } =
      await import("../browser/rango-state");
    const { registerNavigationStore } =
      await import("../browser/navigation-store-handle");
    const { enterActionFence, exitActionFence } =
      await import("../browser/action-fence");

    initRangoState("v1", NAME);
    const store = fakeStore();
    registerNavigationStore(store);

    enterActionFence();
    j.set(NAME, "v1:100:5000");
    expect(getRangoState()).toBe("v1:100:5000");
    expect(store.markCachesStaleAfterWrite).not.toHaveBeenCalled();

    // No landing marked the caches (a keepClientCache() action, say).
    exitActionFence();
    getRangoState();
    expect(store.markCachesStaleAfterWrite).toHaveBeenCalledTimes(1);
  });

  it("does not mark history stale on a self-rotation", async () => {
    const j = makeJar({ [NAME]: "v1:100" });
    vi.stubGlobal("document", j.jar);

    const { initRangoState, invalidateRangoState, getRangoState } =
      await import("../browser/rango-state");
    const { registerNavigationStore } =
      await import("../browser/navigation-store-handle");

    initRangoState("v1", NAME);
    const store = fakeStore();
    registerNavigationStore(store);

    invalidateRangoState();
    getRangoState();
    getRangoState();

    expect(store.markHistoryCacheStale).not.toHaveBeenCalled();
    expect(store.markCachesStaleAfterWrite).not.toHaveBeenCalled();
  });
});
