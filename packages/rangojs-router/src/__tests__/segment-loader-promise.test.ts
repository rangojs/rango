// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
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
  it("returns a Promise resolving to an empty array for zero loaders", async () => {
    const result = getMemoizedLoaderPromise([]);

    expect(result).toBeInstanceOf(Promise);
    await expect(result as Promise<any[]>).resolves.toEqual([]);
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

  it("falls through without caching when the first loaderData is a primitive", () => {
    // Primitive first source can't key a WeakMap — helper still returns a
    // correct Promise.all, just without memoization. Validate correctness.
    const first = getMemoizedLoaderPromise([
      loaderSeg("D0.a", "primitive-a"),
      loaderSeg("D0.b", "primitive-b"),
    ]);
    const second = getMemoizedLoaderPromise([
      loaderSeg("D0.a", "primitive-a"),
      loaderSeg("D0.b", "primitive-b"),
    ]);

    expect(first).toBeInstanceOf(Promise);
    expect(second).toBeInstanceOf(Promise);
    expect(second).not.toBe(first);
  });
});
