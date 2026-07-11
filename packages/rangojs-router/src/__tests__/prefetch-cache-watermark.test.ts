import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { abortAllPrefetchesMock, invalidateRangoStateMock } = vi.hoisted(() => ({
  abortAllPrefetchesMock: vi.fn(),
  invalidateRangoStateMock: vi.fn(),
}));

vi.mock("../browser/prefetch/loader", () => ({
  abortAllPrefetches: abortAllPrefetchesMock,
}));

vi.mock("../browser/rango-state", () => ({
  invalidateRangoState: invalidateRangoStateMock,
}));

import {
  clearPrefetchCache,
  currentGeneration,
  hasPrefetch,
  consumePrefetch,
  initPrefetchCache,
  storePrefetch,
  type DecodedPrefetch,
} from "../browser/prefetch/cache";
import type { RscPayload } from "../browser/types";

function makeEntry(): DecodedPrefetch {
  return {
    payload: Promise.resolve({} as RscPayload),
    streamComplete: Promise.resolve(),
    scope: "wildcard",
    complete: false,
  };
}

// TTL default is 300_000ms.
const TTL = 300_000;

describe("prefetch cache expiry watermark", () => {
  beforeEach(() => {
    clearPrefetchCache();
    abortAllPrefetchesMock.mockClear();
    invalidateRangoStateMock.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // Restore the module-default size for any later suite.
    initPrefetchCache(TTL, 100);
  });

  it("keeps every entry when none has crossed the TTL yet", () => {
    const gen = currentGeneration();
    storePrefetch("w\0/a", makeEntry(), gen);
    vi.advanceTimersByTime(TTL - 1);
    // Watermark gate: now - earliestTimestamp (< TTL) => no sweep, /a retained.
    storePrefetch("w\0/b", makeEntry(), gen);
    expect(hasPrefetch("w\0/a")).toBe(true);
    expect(hasPrefetch("w\0/b")).toBe(true);
  });

  it("sweeps the expired entry on a later store while keeping newer ones", () => {
    const gen = currentGeneration();
    storePrefetch("w\0/a", makeEntry(), gen); // t=0
    vi.advanceTimersByTime(200_000);
    storePrefetch("w\0/b", makeEntry(), gen); // t=200k (fresh)
    // t=350k: /a age 350k (> TTL, expired), /b age 150k (fresh).
    vi.advanceTimersByTime(150_000);
    storePrefetch("w\0/c", makeEntry(), gen); // crosses watermark -> sweeps /a
    expect(hasPrefetch("w\0/a")).toBe(false);
    expect(hasPrefetch("w\0/b")).toBe(true);
    expect(hasPrefetch("w\0/c")).toBe(true);
  });

  it("does not serve an entry past its TTL (consume returns null)", () => {
    const gen = currentGeneration();
    storePrefetch("w\0/x", makeEntry(), gen);
    vi.advanceTimersByTime(TTL + 1);
    expect(consumePrefetch("w\0/x")).toBeNull();
  });

  it("recomputes the watermark after clearPrefetchCache so later expiry still sweeps", () => {
    const gen0 = currentGeneration();
    storePrefetch("g\0/old", makeEntry(), gen0);

    clearPrefetchCache(); // watermark -> Infinity, generation bumps
    const gen1 = currentGeneration();

    storePrefetch("g\0/new", makeEntry(), gen1); // watermark := now
    vi.advanceTimersByTime(TTL + 1); // /new expired
    storePrefetch("g\0/newer", makeEntry(), gen1); // sweep evicts /new
    expect(hasPrefetch("g\0/new")).toBe(false);
    expect(hasPrefetch("g\0/newer")).toBe(true);
  });

  it("still enforces the FIFO size cap alongside the watermark", () => {
    initPrefetchCache(TTL, 3);
    const gen = currentGeneration();
    for (const k of ["a", "b", "c", "d"]) {
      storePrefetch(`s\0/${k}`, makeEntry(), gen);
    }
    // Capacity 3: the 4th store evicts the oldest (a); newest 3 remain.
    expect(hasPrefetch("s\0/a")).toBe(false);
    expect(hasPrefetch("s\0/b")).toBe(true);
    expect(hasPrefetch("s\0/c")).toBe(true);
    expect(hasPrefetch("s\0/d")).toBe(true);
  });
});
