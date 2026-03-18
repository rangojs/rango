import { createLoader } from "../../loader.js";
import { describe, it, expect, vi } from "vitest";
import {
  resolveOrphanLayoutWithRevalidation,
  resolveParallelEntry,
  resolveParallelSegmentsWithRevalidation,
} from "../segment-resolution";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createContext() {
  const request = new Request("https://example.com/blog");
  return {
    params: {},
    request,
    searchParams: new URLSearchParams(),
    pathname: "/blog",
    url: new URL(request.url),
    env: {},
    var: {},
    get: () => undefined,
    set: () => {},
    header: () => {},
    status: () => {},
    html: () => new Response(""),
    json: () => new Response(""),
    text: () => new Response(""),
    redirect: () => new Response(""),
    notFound: () => {
      throw new Error("notFound not implemented in test context");
    },
    use: vi.fn(),
  } as any;
}

function createParallelEntry(handler: any) {
  return {
    id: "blog.sidebar",
    type: "parallel",
    shortCode: "L0P0",
    handler: { "@sidebar": handler },
    loading: "sidebar-loading",
    loader: [],
    layout: [],
    parallel: [],
    intercept: [],
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
  } as any;
}

const TestParallelLoader = (createLoader as Function)(
  async () => ({ sidebar: true }),
  undefined,
  "test#ParallelLoader",
);

describe("segment-resolution parallel loading", () => {
  it("does not await parallel handler promise in revalidation path when loading is set", async () => {
    const deferred = createDeferred<string>();
    const slotHandler = vi.fn(() => deferred.promise);
    const context = createContext();
    const parallelEntry = createParallelEntry(slotHandler);
    const entry = {
      id: "blog.layout",
      type: "layout",
      shortCode: "L0",
      handler: "layout",
      loader: [],
      layout: [],
      parallel: [parallelEntry],
      intercept: [],
      middleware: [],
      revalidate: [],
      errorBoundary: [],
      notFoundBoundary: [],
    } as any;

    const resultPromise = resolveParallelSegmentsWithRevalidation(
      entry,
      {},
      context,
      false,
      new Set(),
      {},
      context.request,
      context.url,
      context.url,
      "/blog",
      { trackHandler: (p: any) => p } as any,
    );

    const quickResult = await Promise.race([
      resultPromise.then(() => "resolved"),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 30),
      ),
    ]);
    expect(quickResult).toBe("resolved");

    const result = await resultPromise;
    expect(slotHandler).toHaveBeenCalledTimes(1);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.type).toBe("parallel");
    expect(result.segments[0]?.component).toBe(deferred.promise);

    deferred.resolve("done");
    await deferred.promise;
  });

  it("does not await orphan parallel handler promise in revalidation path when loading is set", async () => {
    const deferred = createDeferred<string>();
    const slotHandler = vi.fn(() => deferred.promise);
    const context = createContext();
    const orphan = {
      id: "blog.orphan",
      type: "layout",
      shortCode: "L1",
      handler: "layout",
      loading: "layout-loading",
      loader: [],
      layout: [],
      parallel: [createParallelEntry(slotHandler)],
      intercept: [],
      middleware: [],
      revalidate: [],
      errorBoundary: [],
      notFoundBoundary: [],
    } as any;

    const resultPromise = resolveOrphanLayoutWithRevalidation(
      orphan,
      {},
      context,
      new Set(),
      {},
      context.request,
      context.url,
      context.url,
      "/blog",
      new Map(),
      false,
      { trackHandler: (p: any) => p } as any,
    );

    const quickResult = await Promise.race([
      resultPromise.then(() => "resolved"),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 30),
      ),
    ]);
    expect(quickResult).toBe("resolved");

    const result = await resultPromise;
    const parallelSegment = result.segments.find((s) => s.type === "parallel");
    expect(slotHandler).toHaveBeenCalledTimes(1);
    expect(parallelSegment).toBeDefined();
    expect(parallelSegment?.component).toBe(deferred.promise);

    deferred.resolve("done");
    await deferred.promise;
  });

  it("awaits parallel handler when loading is explicitly false", async () => {
    const deferred = createDeferred<string>();
    const slotHandler = vi.fn(() => deferred.promise);
    const context = createContext();
    const entry = {
      id: "blog.layout",
      type: "layout",
      shortCode: "L0",
      handler: "layout",
      loader: [],
      layout: [],
      parallel: [
        {
          ...createParallelEntry(slotHandler),
          loading: false,
        },
      ],
      intercept: [],
      middleware: [],
      revalidate: [],
      errorBoundary: [],
      notFoundBoundary: [],
    } as any;

    const resultPromise = resolveParallelSegmentsWithRevalidation(
      entry,
      {},
      context,
      false,
      new Set(),
      {},
      context.request,
      context.url,
      context.url,
      "/blog",
      { trackHandler: (p: any) => p } as any,
    );

    const quickResult = await Promise.race([
      resultPromise.then(() => "resolved"),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 30),
      ),
    ]);
    expect(quickResult).toBe("timeout");

    deferred.resolve("done");
    await deferred.promise;

    const result = await resultPromise;
    expect(slotHandler).toHaveBeenCalledTimes(1);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.type).toBe("parallel");
  });

  it("resolves parallel loaders even when loading is set", async () => {
    const context = createContext();
    const entry = {
      ...createParallelEntry(() => "sidebar"),
      loader: [{ loader: TestParallelLoader, revalidate: [] }],
    } as any;

    const segments = await resolveParallelEntry(
      entry,
      {},
      context,
      false,
      "L0",
      {
        wrapLoaderPromise: vi.fn((promise: Promise<any>) => promise),
        trackHandler: vi.fn((p: any) => p),
      } as any,
    );

    expect(segments.map((segment) => segment.type)).toEqual([
      "parallel",
      "loader",
    ]);
    expect(segments[1]?.id).toBe("L0D0.test#ParallelLoader");
  });

  it("revalidation resolves parallel loaders even when loading is set", async () => {
    const context = createContext();
    const entry = {
      id: "blog.layout",
      type: "layout",
      shortCode: "L0",
      handler: "layout",
      loader: [],
      layout: [],
      parallel: [
        {
          ...createParallelEntry(() => "sidebar"),
          loader: [{ loader: TestParallelLoader, revalidate: [] }],
        },
      ],
      intercept: [],
      middleware: [],
      revalidate: [],
      errorBoundary: [],
      notFoundBoundary: [],
    } as any;

    const result = await resolveParallelSegmentsWithRevalidation(
      entry,
      {},
      context,
      false,
      new Set<string>(),
      {},
      context.request,
      context.url,
      context.url,
      "/blog",
      {
        wrapLoaderPromise: vi.fn((promise: Promise<any>) => promise),
        trackHandler: vi.fn((p: any) => p),
      } as any,
    );

    expect(result.segments.map((segment) => segment.type)).toEqual([
      "parallel",
      "loader",
    ]);
    expect(result.segments[1]?.id).toBe("L0D0.test#ParallelLoader");
  });
});
