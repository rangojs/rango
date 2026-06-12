import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NavigationStore } from "../browser/types.js";

function makeJar(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial };
  return {
    jar: {
      get cookie(): string {
        return Object.entries(store)
          .map(([k, v]) => `${k}=${v}`)
          .join("; ");
      },
      set cookie(str: string) {
        const seg = str.split(";")[0];
        const eq = seg.indexOf("=");
        if (eq < 0) return;
        store[seg.slice(0, eq).trim()] = seg.slice(eq + 1);
      },
    },
    set: (k: string, v: string) => {
      store[k] = v;
    },
  };
}

const NAME = "rango-state_router_0";

function fakeStore(): NavigationStore {
  return { markHistoryCacheStale: vi.fn() } as unknown as NavigationStore;
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
  });
});
