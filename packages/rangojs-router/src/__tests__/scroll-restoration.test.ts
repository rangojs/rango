// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  initScrollRestoration,
  saveCurrentScrollPosition,
  persistToSessionStorage,
  getSavedScrollPosition,
  getScrollKey,
} from "../browser/scroll-restoration.js";

const SCROLL_STORAGE_KEY = "rsc-router-scroll-positions";

// Module-level state in scroll-restoration.ts (savedScrollPositions,
// scrollKeyOrder, initialized) persists across tests in this file. The cleanup
// returned by initScrollRestoration resets it; we always call it in afterEach.
let cleanup: (() => void) | null = null;

// The current scroll key, driven by a custom getKey so a test can control
// exactly which slot a save lands in (independent of history.state).
let currentKey = "k0";

function setScrollY(y: number): void {
  Object.defineProperty(window, "scrollY", {
    value: y,
    configurable: true,
    writable: true,
  });
}

/**
 * A controllable in-memory sessionStorage stub installed as the global so the
 * quota-exceeded ladder is deterministic. Spying happy-dom's real Storage
 * across tests proved flaky; a fresh stub per test is robust.
 */
function fakeSessionStorage(setItem: (key: string, value: string) => void): {
  setItem: ReturnType<typeof vi.fn>;
  getItem: ReturnType<typeof vi.fn>;
  removeItem: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  key: ReturnType<typeof vi.fn>;
  length: number;
} {
  return {
    setItem: vi.fn(setItem),
    getItem: vi.fn(() => null),
    removeItem: vi.fn(),
    clear: vi.fn(),
    key: vi.fn(),
    length: 0,
  };
}

beforeEach(() => {
  currentKey = "k0";
  setScrollY(0);
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("scroll-restoration LRU eviction", () => {
  it("bounds saved positions and evicts the oldest key beyond MAX_SCROLL_ENTRIES", () => {
    cleanup = initScrollRestoration({ getKey: () => currentKey });

    // Save 201 distinct keys (k0..k200). MAX_SCROLL_ENTRIES is 200, so the
    // oldest (k0) must be evicted after the 201st save.
    for (let i = 0; i <= 200; i++) {
      currentKey = `k${i}`;
      setScrollY(i * 10);
      saveCurrentScrollPosition();
    }

    // Oldest key evicted.
    expect(getSavedScrollPosition("k0")).toBeUndefined();
    // Second-oldest retained (it is within the 200-entry window).
    expect(getSavedScrollPosition("k1")).toBe(10);
    // Most-recent retained with its scroll value.
    expect(getSavedScrollPosition("k200")).toBe(2000);

    // Exactly the window size remains: k1..k200 present (200 entries),
    // and one more save past 200 evicts the next-oldest (k1).
    currentKey = "k201";
    setScrollY(2010);
    saveCurrentScrollPosition();
    expect(getSavedScrollPosition("k1")).toBeUndefined();
    expect(getSavedScrollPosition("k2")).toBe(20);
    expect(getSavedScrollPosition("k201")).toBe(2010);
  });

  it("re-saving an existing key moves it to MRU (no duplicate, not evicted)", () => {
    cleanup = initScrollRestoration({ getKey: () => currentKey });

    // Fill exactly to the cap with k0..k199 (200 entries).
    for (let i = 0; i < 200; i++) {
      currentKey = `k${i}`;
      setScrollY(i);
      saveCurrentScrollPosition();
    }

    // Re-save k0 (the oldest): it must move to MRU, not stay at the front.
    currentKey = "k0";
    setScrollY(9999);
    saveCurrentScrollPosition();

    // k0 updated in place (no duplicate slot), value refreshed.
    expect(getSavedScrollPosition("k0")).toBe(9999);

    // Still at the cap (re-save did not grow the store), so k1 is now the
    // oldest. One more new key evicts k1, NOT the just-refreshed k0.
    currentKey = "k200";
    setScrollY(2000);
    saveCurrentScrollPosition();

    expect(getSavedScrollPosition("k1")).toBeUndefined();
    expect(getSavedScrollPosition("k0")).toBe(9999); // survived (was MRU)
    expect(getSavedScrollPosition("k200")).toBe(2000);
  });
});

describe("scroll-restoration sessionStorage quota retry", () => {
  it("evicts ~1/4 and retries once when setItem throws QuotaExceededError", () => {
    // First setItem (persist attempt) throws quota; the retry is a no-op
    // success so we can introspect what the eviction step removed.
    let call = 0;
    const fs = fakeSessionStorage(() => {
      call++;
      if (call === 1) {
        throw new DOMException("Quota", "QuotaExceededError");
      }
    });
    vi.stubGlobal("sessionStorage", fs);

    cleanup = initScrollRestoration({ getKey: () => currentKey });

    // 9 entries total (q0..q8) so the 1/4 eviction is floor(9/4) = 2.
    for (let i = 0; i < 9; i++) {
      currentKey = `q${i}`;
      setScrollY(i);
      saveCurrentScrollPosition();
    }

    persistToSessionStorage();

    // Initial write threw, then a single retry write — exactly 2 setItem calls.
    expect(fs.setItem).toHaveBeenCalledTimes(2);
    // No fall-through to removeItem because the retry succeeded.
    expect(fs.removeItem).not.toHaveBeenCalled();

    // The two oldest keys (q0, q1) were evicted before the retry.
    expect(getSavedScrollPosition("q0")).toBeUndefined();
    expect(getSavedScrollPosition("q1")).toBeUndefined();
    expect(getSavedScrollPosition("q2")).toBe(2);
    expect(getSavedScrollPosition("q8")).toBe(8);
  });

  it("removes the storage key when setItem always throws (does not loop)", () => {
    const fs = fakeSessionStorage(() => {
      throw new DOMException("Quota", "QuotaExceededError");
    });
    vi.stubGlobal("sessionStorage", fs);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    cleanup = initScrollRestoration({ getKey: () => currentKey });

    for (let i = 0; i < 5; i++) {
      currentKey = `r${i}`;
      setScrollY(i);
      saveCurrentScrollPosition();
    }

    // Must not throw or loop forever; falls back to removeItem.
    expect(() => persistToSessionStorage()).not.toThrow();

    // Initial write + one retry, both threw -> bounded retry (2 attempts).
    expect(fs.setItem).toHaveBeenCalledTimes(2);
    // Cleared our key so we don't block co-tenant sessionStorage consumers.
    expect(fs.removeItem).toHaveBeenCalledWith(SCROLL_STORAGE_KEY);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("persists in a single write when under quota (no eviction)", () => {
    const fs = fakeSessionStorage(() => {
      // Always succeeds.
    });
    vi.stubGlobal("sessionStorage", fs);

    cleanup = initScrollRestoration({ getKey: () => currentKey });

    currentKey = "ok0";
    setScrollY(10);
    saveCurrentScrollPosition();

    persistToSessionStorage();

    // One successful write, no eviction, no removeItem.
    expect(fs.setItem).toHaveBeenCalledTimes(1);
    expect(fs.removeItem).not.toHaveBeenCalled();
    // The written payload contains the saved position.
    const written = JSON.parse(fs.setItem.mock.calls[0][1] as string);
    expect(written.ok0).toBe(10);
  });
});

describe("scroll-restoration custom getKey", () => {
  it("collapses distinct history entries that map to the same key into one slot", () => {
    // getKey ignores the unique history key and collapses by pathname only,
    // so two different navigations to the same pathname share one scroll slot.
    cleanup = initScrollRestoration({
      getKey: (loc) => loc.pathname,
    });

    // Drive window.location.pathname via happy-dom navigation.
    window.history.pushState({}, "", "/products?page=1");
    setScrollY(100);
    saveCurrentScrollPosition();
    expect(getSavedScrollPosition("/products")).toBe(100);

    // A second visit to the same pathname (different search) collapses to the
    // SAME "/products" slot and overwrites — not a new entry.
    window.history.pushState({}, "", "/products?page=2");
    setScrollY(250);
    saveCurrentScrollPosition();

    expect(getSavedScrollPosition("/products")).toBe(250);

    // getScrollKey reflects the custom collapsing.
    expect(getScrollKey()).toBe("/products");
  });

  it("uses the history state key when no custom getKey is provided", () => {
    cleanup = initScrollRestoration();

    setScrollY(55);
    saveCurrentScrollPosition();

    // The key is a generated history-state key (8-char base36), and the saved
    // value is retrievable under the current scroll key.
    const key = getScrollKey();
    expect(typeof key).toBe("string");
    expect(getSavedScrollPosition(key)).toBe(55);
  });
});
