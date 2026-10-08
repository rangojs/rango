// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from "vitest";
import type { ResolvedSegment } from "../types";
import { getMemoizedLoaderPromise } from "../segment-loader-promise";

function loaderSeg(id: string, loaderData: any): ResolvedSegment {
  return {
    id,
    namespace: "",
    type: "loader",
    index: 0,
    component: null,
    loaderId: id,
    loaderData,
  } as ResolvedSegment;
}

describe("getMemoizedLoaderPromise", () => {
  // Why an array and not a promise: see the header of segment-loader-promise.ts.
  it("returns one shared empty array for zero loaders in the browser", () => {
    const result = getMemoizedLoaderPromise([]);

    expect(result).toEqual([]);
    expect(getMemoizedLoaderPromise([])).toBe(result);
  });

  it("reuses the same aggregate when loader.loaderData refs are unchanged", () => {
    const dataA = Promise.resolve({ a: 1 });
    const dataB = Promise.resolve({ b: 2 });
    const loaders = [loaderSeg("D0.a", dataA), loaderSeg("D0.b", dataB)];

    const first = getMemoizedLoaderPromise(loaders);
    const second = getMemoizedLoaderPromise(loaders);

    expect(second).toBe(first);
  });

  it("reuses the aggregate across fresh loader segment objects that share loaderData refs", () => {
    const dataA = Promise.resolve({ a: 1 });
    const dataB = Promise.resolve({ b: 2 });
    const loadersFirstRender = [
      loaderSeg("D0.a", dataA),
      loaderSeg("D0.b", dataB),
    ];
    const loadersSecondRender = [
      loaderSeg("D0.a", dataA),
      loaderSeg("D0.b", dataB),
    ];

    const first = getMemoizedLoaderPromise(loadersFirstRender);
    const second = getMemoizedLoaderPromise(loadersSecondRender);

    expect(second).toBe(first);
  });

  it("rebuilds the aggregate when any loaderData ref changes", () => {
    const dataA = Promise.resolve({ a: 1 });
    const dataB = Promise.resolve({ b: 2 });
    const dataBNext = Promise.resolve({ b: 3 });

    const first = getMemoizedLoaderPromise([
      loaderSeg("D0.a", dataA),
      loaderSeg("D0.b", dataB),
    ]);
    const second = getMemoizedLoaderPromise([
      loaderSeg("D0.a", dataA),
      loaderSeg("D0.b", dataBNext),
    ]);

    expect(second).not.toBe(first);
  });

  it("distinguishes aggregates sharing the first ref but differing in subsequent refs", () => {
    const shared = Promise.resolve({ a: 1 });
    const tailX = Promise.resolve({ x: 1 });
    const tailY = Promise.resolve({ y: 1 });

    const x = getMemoizedLoaderPromise([
      loaderSeg("Dx.a", shared),
      loaderSeg("Dx.t", tailX),
    ]);
    const y = getMemoizedLoaderPromise([
      loaderSeg("Dy.a", shared),
      loaderSeg("Dy.t", tailY),
    ]);
    const xAgain = getMemoizedLoaderPromise([
      loaderSeg("Dx.a", shared),
      loaderSeg("Dx.t", tailX),
    ]);

    expect(x).not.toBe(y);
    expect(xAgain).toBe(x);
  });

  it("memoizes when the first loaderData is a primitive via the fallback cache", () => {
    // Primitive first sources can't key a WeakMap, so they land in a Map
    // fallback. Loaders returning plain-value data (strings, numbers) still
    // benefit from memoization — otherwise a fresh Promise.all each render
    // would reintroduce the flicker this helper exists to prevent.
    const first = getMemoizedLoaderPromise([
      loaderSeg("D0.a", "primitive-a"),
      loaderSeg("D0.b", "primitive-b"),
    ]);
    const second = getMemoizedLoaderPromise([
      loaderSeg("D0.a", "primitive-a"),
      loaderSeg("D0.b", "primitive-b"),
    ]);

    expect(first).toBeInstanceOf(Promise);
    expect(second).toBe(first);
  });

  it("invalidates the primitive-keyed aggregate when a later source ref changes", () => {
    const first = getMemoizedLoaderPromise([
      loaderSeg("D1.a", "shared-a"),
      loaderSeg("D1.b", "tail-first"),
    ]);
    const second = getMemoizedLoaderPromise([
      loaderSeg("D1.a", "shared-a"),
      loaderSeg("D1.b", "tail-second"),
    ]);

    expect(second).not.toBe(first);
  });

  it("memoizes when first loaderData is null (null-data loader)", () => {
    const first = getMemoizedLoaderPromise([
      loaderSeg("D2.a", null),
      loaderSeg("D2.b", "tail"),
    ]);
    const second = getMemoizedLoaderPromise([
      loaderSeg("D2.a", null),
      loaderSeg("D2.b", "tail"),
    ]);

    expect(second).toBe(first);
  });

  it("bounds the per-key entries array so a long session does not leak", () => {
    // A stable layout-level loader (its loaderData ref preserved across
    // navigations) keeps the WeakMap key alive, while a per-route loader whose
    // ref changes each navigation produces a brand-new sources array every time.
    // Without eviction the per-key array grows linearly with navigation count,
    // each stale entry pinning a Promise + sources array from GC. The cap drops
    // the oldest entries, so a much earlier navigation's combo is no longer
    // memoized (returns a fresh promise) while recent ones still hit.
    const stableFirst = { layout: "data" }; // same object ref every nav
    const tails = Array.from({ length: 50 }, (_, i) =>
      Promise.resolve({ route: i }),
    );

    const promiseFor = (tail: Promise<unknown>) =>
      getMemoizedLoaderPromise([
        loaderSeg("D0.layout", stableFirst),
        loaderSeg("D0.route", tail),
      ]);

    // First navigation's combo.
    const firstNavPromise = promiseFor(tails[0]!);

    // Many subsequent navigations under the SAME stable first ref.
    for (let i = 1; i < tails.length; i++) {
      promiseFor(tails[i]!);
    }

    // The earliest combo must have been evicted (bounded array): re-requesting
    // it rebuilds a fresh promise rather than returning the original.
    const firstNavAgain = promiseFor(tails[0]!);
    expect(firstNavAgain).not.toBe(firstNavPromise);

    // A recent combo still hits (the cap keeps the most-recent entries warm).
    const recentPromise = promiseFor(tails[tails.length - 1]!);
    const recentAgain = promiseFor(tails[tails.length - 1]!);
    expect(recentAgain).toBe(recentPromise);
  });

  describe("settled aggregates", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.resetModules();
    });

    it("returns the promise until the aggregate settles, then the same array", async () => {
      const loaders = [
        loaderSeg("D0.a", Promise.resolve({ a: 1 })),
        loaderSeg("D0.b", { b: 2 }),
      ];

      const first = getMemoizedLoaderPromise(loaders);
      expect(first).toBeInstanceOf(Promise);
      expect(await first).toEqual([{ a: 1 }, { b: 2 }]);

      const second = getMemoizedLoaderPromise(loaders);
      expect(second).toBe(await first);
      expect(getMemoizedLoaderPromise(loaders)).toBe(second);
      // Fresh segment objects over the same refs hit the same entry.
      expect(getMemoizedLoaderPromise(loaders.map((l) => ({ ...l })))).toBe(
        second,
      );
    });

    // The entry of a page is rewritten with streams no tree has read yet
    // (a `prefetch: false` fill, browser/partial-update.ts settleHoles): the
    // first render from it is the first call for these sources. A promise
    // built over them would be one more promise React has not read, and a
    // slot's boundary handed it in a render that cannot wait shows its
    // fallback over content that is on screen.
    it("returns the array at once when every source is a stream that has fulfilled", () => {
      const fulfilled = (value: unknown) =>
        Object.assign(Promise.resolve(value), { status: "fulfilled", value });
      const loaders = [
        loaderSeg("D0.a", fulfilled({ a: 1 })),
        loaderSeg("D0.b", fulfilled({ b: 2 })),
      ];

      const first = getMemoizedLoaderPromise(loaders);
      expect(first).toEqual([{ a: 1 }, { b: 2 }]);
      expect(getMemoizedLoaderPromise(loaders)).toBe(first);
    });

    it("returns the promise while one source is a stream that has not", () => {
      const fulfilled = Object.assign(Promise.resolve(1), {
        status: "fulfilled",
        value: 1,
      });
      const pending = Object.assign(new Promise(() => {}), {
        status: "pending",
      });

      expect(
        getMemoizedLoaderPromise([
          loaderSeg("D0.a", fulfilled),
          loaderSeg("D0.b", pending),
        ]),
      ).toBeInstanceOf(Promise);
    });

    it("keeps returning the promise for a rejected aggregate, and reading it rejects", async () => {
      const loaders = [
        loaderSeg("D0.a", Promise.reject(new Error("loader failed"))),
      ];

      const first = getMemoizedLoaderPromise(loaders) as Promise<unknown>;
      await expect(first).rejects.toThrow("loader failed");

      expect(getMemoizedLoaderPromise(loaders)).toBe(first);
    });

    it("builds a new entry when a loaderData ref changes after a settle", async () => {
      const dataA = Promise.resolve({ a: 1 });
      await getMemoizedLoaderPromise([loaderSeg("D0.a", dataA)]);
      expect(
        Array.isArray(getMemoizedLoaderPromise([loaderSeg("D0.a", dataA)])),
      ).toBe(true);

      const next = getMemoizedLoaderPromise([
        loaderSeg("D0.a", Promise.resolve({ a: 2 })),
      ]);

      expect(next).toBeInstanceOf(Promise);
    });

    it("hands the server a fresh promise on every call", async () => {
      vi.resetModules();
      vi.stubGlobal("window", undefined);
      const server = await import("../segment-loader-promise");
      const loaders = [loaderSeg("D0.a", Promise.resolve({ a: 1 }))];

      const first = server.getMemoizedLoaderPromise(loaders);
      await first;
      const second = server.getMemoizedLoaderPromise(loaders);

      expect(first).toBeInstanceOf(Promise);
      expect(second).toBeInstanceOf(Promise);
      expect(second).not.toBe(first);
      expect(server.getMemoizedLoaderPromise([])).toBeInstanceOf(Promise);
    });
  });
});
