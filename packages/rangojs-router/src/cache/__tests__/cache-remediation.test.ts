import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// 1. Profile validation and grammar
// ============================================================================

describe("cache profile validation", () => {
  let setCacheProfiles: typeof import("../profile-registry.js").setCacheProfiles;
  let getCacheProfile: typeof import("../profile-registry.js").getCacheProfile;

  beforeEach(async () => {
    // Re-import to get fresh module state
    const mod = await import("../profile-registry.js");
    setCacheProfiles = mod.setCacheProfiles;
    getCacheProfile = mod.getCacheProfile;
  });

  it("accepts names with letters, digits, hyphens, and underscores", () => {
    expect(() =>
      setCacheProfiles({
        default: { ttl: 60 },
        short: { ttl: 10 },
        "long-lived": { ttl: 3600 },
        with_underscore: { ttl: 300 },
        "mix-ed_123": { ttl: 120 },
      }),
    ).not.toThrow();
  });

  it("rejects names with spaces", () => {
    expect(() =>
      setCacheProfiles({
        default: { ttl: 60 },
        "bad name": { ttl: 10 },
      }),
    ).toThrow(/Invalid cache profile name/);
  });

  it("rejects names with special characters", () => {
    expect(() =>
      setCacheProfiles({
        default: { ttl: 60 },
        "bad.name": { ttl: 10 },
      }),
    ).toThrow(/Invalid cache profile name/);
  });

  it("rejects empty string name", () => {
    expect(() =>
      setCacheProfiles({
        default: { ttl: 60 },
        "": { ttl: 10 },
      }),
    ).toThrow(/Invalid cache profile name/);
  });

  it("always ensures a default profile exists", () => {
    setCacheProfiles({ short: { ttl: 10 } });
    const defaultProfile = getCacheProfile("default");
    expect(defaultProfile).toBeDefined();
    expect(defaultProfile!.ttl).toBe(900);
  });

  it("preserves user-defined default profile", () => {
    setCacheProfiles({ default: { ttl: 42 } });
    const defaultProfile = getCacheProfile("default");
    expect(defaultProfile!.ttl).toBe(42);
  });
});

// ============================================================================
// 2. Multi-router profile isolation
// ============================================================================

describe("multi-router profile isolation", () => {
  let setCacheProfiles: typeof import("../profile-registry.js").setCacheProfiles;
  let getCacheProfile: typeof import("../profile-registry.js").getCacheProfile;

  beforeEach(async () => {
    const mod = await import("../profile-registry.js");
    setCacheProfiles = mod.setCacheProfiles;
    getCacheProfile = mod.getCacheProfile;
  });

  it("setCacheProfiles replaces previous profiles entirely", () => {
    setCacheProfiles({
      default: { ttl: 60 },
      routerA: { ttl: 100 },
    });
    expect(getCacheProfile("routerA")).toBeDefined();

    // Second router replaces profiles
    setCacheProfiles({
      default: { ttl: 30 },
      routerB: { ttl: 200 },
    });

    expect(getCacheProfile("routerB")).toBeDefined();
    expect(getCacheProfile("routerA")).toBeUndefined();
  });
});

// ============================================================================
// 3. Directive grammar regex (from use-cache-transform)
// ============================================================================

describe("use-cache directive grammar", () => {
  // The regex used by the Vite transform for function-level directives
  const directiveRegex = /^use cache(:\s*[\w-]+)?$/;

  it("matches plain 'use cache'", () => {
    expect(directiveRegex.test("use cache")).toBe(true);
  });

  it("matches 'use cache: short'", () => {
    expect(directiveRegex.test("use cache: short")).toBe(true);
  });

  it("matches profile names with hyphens", () => {
    expect(directiveRegex.test("use cache: long-lived")).toBe(true);
  });

  it("matches profile names with underscores", () => {
    expect(directiveRegex.test("use cache: with_underscore")).toBe(true);
  });

  it("matches profile names with digits", () => {
    expect(directiveRegex.test("use cache: cache123")).toBe(true);
  });

  it("matches mixed names", () => {
    expect(directiveRegex.test("use cache: mix-ed_123")).toBe(true);
  });

  it("rejects names with dots", () => {
    expect(directiveRegex.test("use cache: bad.name")).toBe(false);
  });

  it("rejects names with spaces", () => {
    expect(directiveRegex.test("use cache: bad name")).toBe(false);
  });

  it("rejects unrelated directives", () => {
    expect(directiveRegex.test("use server")).toBe(false);
    expect(directiveRegex.test("use client")).toBe(false);
  });
});

// ============================================================================
// 4. Handle capture reentrance (save/restore pattern)
// ============================================================================

describe("handle capture reentrance", () => {
  it("nested captures restore correctly in LIFO order", () => {
    // Simulate HandleStore as an object with push as own property
    const pushLog: string[] = [];
    const store = {
      push(handleName: string, segmentId: string, value: unknown) {
        pushLog.push(`original:${handleName}:${segmentId}:${value}`);
      },
    };

    type PushFn = (
      handleName: string,
      segmentId: string,
      value: unknown,
    ) => void;

    // Simulate startHandleCapture (save/restore pattern)
    function startCapture(s: { push: PushFn }) {
      const capturedData: string[] = [];
      const previousPush = s.push.bind(s);

      s.push = (handleName: string, segmentId: string, value: unknown) => {
        capturedData.push(`${handleName}:${segmentId}:${value}`);
        previousPush(handleName, segmentId, value);
      };

      return {
        data: capturedData,
        stop() {
          s.push = previousPush;
        },
      };
    }

    // Outer capture
    const outer = startCapture(store);
    store.push("breadcrumbs", "seg1", "Home");

    // Nested capture
    const inner = startCapture(store);
    store.push("meta", "seg2", "Title");

    // Stop inner capture (LIFO)
    inner.stop();

    // After inner stop, push should still go through outer capture
    store.push("breadcrumbs", "seg1", "Shop");

    // Stop outer capture
    outer.stop();

    // After both stopped, push goes to original
    store.push("breadcrumbs", "seg1", "Final");

    // Verify inner captured only its push
    expect(inner.data).toEqual(["meta:seg2:Title"]);

    // Verify outer captured its own pushes AND the inner push (via chain)
    expect(outer.data).toEqual([
      "breadcrumbs:seg1:Home",
      "meta:seg2:Title",
      "breadcrumbs:seg1:Shop",
    ]);

    // Verify original received all pushes
    expect(pushLog).toEqual([
      "original:breadcrumbs:seg1:Home",
      "original:meta:seg2:Title",
      "original:breadcrumbs:seg1:Shop",
      "original:breadcrumbs:seg1:Final",
    ]);
  });

  it("store.push still works after capture stop", () => {
    let pushCount = 0;
    const store = {
      push(_h: string, _s: string, _v: unknown) {
        pushCount++;
      },
    };

    type PushFn = (h: string, s: string, v: unknown) => void;

    function startCapture(s: { push: PushFn }) {
      const previousPush = s.push.bind(s);
      s.push = (h: string, seg: string, v: unknown) => {
        previousPush(h, seg, v);
      };
      return {
        stop() {
          s.push = previousPush;
        },
      };
    }

    const capture = startCapture(store);
    store.push("h", "s", 1);
    capture.stop();
    store.push("h", "s", 2);

    // Both pushes should reach the original
    expect(pushCount).toBe(2);
  });
});

// ============================================================================
// 5. sortedSearchString (shared key generation logic)
// ============================================================================

describe("sorted search string for cache keys", () => {
  // Replicate the function to test its behavior directly
  function sortedSearchString(searchParams: URLSearchParams): string {
    const pairs: [string, string][] = [];
    for (const [k, v] of searchParams) {
      if (!k.startsWith("_rsc") && !k.startsWith("__")) {
        pairs.push([k, v]);
      }
    }
    if (pairs.length === 0) return "";
    pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return pairs
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
  }

  it("returns empty string when no user-facing params", () => {
    const sp = new URLSearchParams("_rsc_partial=1&__debug=true");
    expect(sortedSearchString(sp)).toBe("");
  });

  it("excludes _rsc* params", () => {
    const sp = new URLSearchParams("page=1&_rsc_partial=1&_rsc_segments=M0L0");
    expect(sortedSearchString(sp)).toBe("page=1");
  });

  it("excludes __* params", () => {
    const sp = new URLSearchParams("page=1&__debug=true&__trace=abc");
    expect(sortedSearchString(sp)).toBe("page=1");
  });

  it("sorts params alphabetically", () => {
    const sp = new URLSearchParams("z=1&a=2&m=3");
    expect(sortedSearchString(sp)).toBe("a=2&m=3&z=1");
  });

  it("produces same output regardless of insertion order", () => {
    const sp1 = new URLSearchParams("z=1&a=2&m=3");
    const sp2 = new URLSearchParams("m=3&z=1&a=2");
    expect(sortedSearchString(sp1)).toBe(sortedSearchString(sp2));
  });

  it("encodes special characters", () => {
    const sp = new URLSearchParams("q=hello world&tag=a+b");
    const result = sortedSearchString(sp);
    expect(result).toContain("q=hello%20world");
  });
});
