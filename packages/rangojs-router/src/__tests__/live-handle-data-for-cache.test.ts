import { describe, expect, it } from "vitest";
import { liveHandleDataForCache } from "../browser/navigation-store.js";
import type { HandleData } from "../browser/types.js";

const SNAPSHOT: HandleData = { notes: { L0: ["document"] } };
const CACHED: HandleData = { notes: { L0: ["document", "late"] } };
const LIVE: HandleData = { notes: { L0: ["live"] } };

function controller(locked: boolean) {
  return {
    getHydrationSnapshot: () => (locked ? ({} as never) : undefined),
    getHandleState: () => ({
      data: locked ? SNAPSHOT : LIVE,
      segmentOrder: [],
      routeSegmentIds: [],
    }),
  };
}

const store = (handleData?: HandleData) => ({
  getCachedSegments: () => ({ segments: [], stale: false, handleData }),
});

describe("liveHandleDataForCache", () => {
  it("returns the controller's data outside the hydration window", () => {
    expect(liveHandleDataForCache(controller(false), store(CACHED), "k")).toBe(
      LIVE,
    );
  });

  it("returns the entry's data during the window, which holds the late pushes", () => {
    expect(liveHandleDataForCache(controller(true), store(CACHED), "k")).toBe(
      CACHED,
    );
  });

  it("falls back to the snapshot when the entry has no handle data", () => {
    expect(liveHandleDataForCache(controller(true), store(), "k")).toBe(
      SNAPSHOT,
    );
  });
});
