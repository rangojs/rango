import { describe, it, expect, vi, afterEach } from "vitest";
import { RSCRouterContext, track } from "../../server/context.js";
import type { MetricsStore } from "../../server/context.js";
import { runWithRouterContext } from "../router-context.js";
import { resolveSegment, resolveParallelEntry } from "../segment-resolution";
import { resolveEntryHandlerWithRevalidation } from "../segment-resolution/revalidation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMetrics(): MetricsStore {
  return { enabled: true, requestStart: performance.now(), metrics: [] };
}

function runWithMetrics<T>(metrics: MetricsStore, fn: () => T): T {
  return RSCRouterContext.run(
    {
      manifest: new Map(),
      namespace: "",
      parent: null,
      counters: {},
      patterns: new Map(),
      patternsByPrefix: new Map(),
      trailingSlash: new Map(),
      searchSchemas: new Map(),
      metrics,
    } as any,
    fn,
  );
}

function createContext(pathname = "/test") {
  const request = new Request(`https://example.com${pathname}`);
  return {
    params: {},
    request,
    searchParams: new URLSearchParams(),
    pathname,
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
      throw new Error("notFound not implemented");
    },
    use: vi.fn(),
  } as any;
}

function createDeps() {
  return {
    wrapLoaderPromise: vi.fn(),
    trackHandler: vi.fn((p: Promise<any>) => p),
    findNearestErrorBoundary: () => undefined,
    findNearestNotFoundBoundary: () => undefined,
    callOnError: vi.fn(),
  } as any;
}

function minimalRouterCtx() {
  return {
    resolveAllSegments: vi.fn(),
    resolveAllSegmentsWithRevalidation: vi.fn(),
    findInterceptForRoute: () => null,
  } as any;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// track() unit tests
// ---------------------------------------------------------------------------

describe("track()", () => {
  it("records timing with depth when metrics are enabled", () => {
    const metrics = createMetrics();
    runWithMetrics(metrics, () => {
      const done = track("test-op", 1);
      done();
    });

    expect(metrics.metrics).toHaveLength(1);
    expect(metrics.metrics[0]!.label).toBe("test-op");
    expect(metrics.metrics[0]!.depth).toBe(1);
    expect(metrics.metrics[0]!.duration).toBeGreaterThanOrEqual(0);
  });

  it("is a no-op when metrics are not enabled", () => {
    const done = track("orphan", 0);
    done();
    // No crash, no metrics recorded (no store at all)
  });

  it("records timing when done callback fires asynchronously via .finally()", async () => {
    const metrics = createMetrics();

    await runWithMetrics(metrics, async () => {
      const done = track("async-handler", 2);
      // Simulate a streamed handler: the Promise settles after a delay
      const promise = new Promise<string>((resolve) =>
        setTimeout(() => resolve("rendered"), 50),
      );
      promise.finally(done).catch(() => {});
      // At this point, done has NOT been called yet
      expect(metrics.metrics).toHaveLength(0);

      await promise;
      // After settling, .finally() runs and records the metric
      // Need a microtask tick for .finally() to fire
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(metrics.metrics).toHaveLength(1);
    expect(metrics.metrics[0]!.label).toBe("async-handler");
    expect(metrics.metrics[0]!.depth).toBe(2);
    expect(metrics.metrics[0]!.duration).toBeGreaterThanOrEqual(40);
  });

  it("records timing via .finally() even when promise rejects", async () => {
    const metrics = createMetrics();

    await runWithMetrics(metrics, async () => {
      const done = track("rejecting-handler", 2);
      const promise = new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("boom")), 20),
      );
      promise.finally(done).catch(() => {});

      await promise.catch(() => {});
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(metrics.metrics).toHaveLength(1);
    expect(metrics.metrics[0]!.label).toBe("rejecting-handler");
    expect(metrics.metrics[0]!.duration).toBeGreaterThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// Integration: streamed route handler timing via resolveSegment
// ---------------------------------------------------------------------------

describe("streamed handler timing — fresh path", () => {
  it("records handler timing after streamed route promise settles", async () => {
    const metrics = createMetrics();
    const ctx = createContext();
    const deps = createDeps();

    let resolveHandler!: (value: string) => void;
    const handlerPromise = new Promise<string>((resolve) => {
      resolveHandler = resolve;
    });

    const entry = {
      id: "blog.post",
      type: "route",
      shortCode: "R0",
      handler: () => handlerPromise,
      loading: "loading...",
      loader: [],
      layout: [],
      parallel: {},
      intercept: [],
      middleware: [],
      revalidate: [],
      errorBoundary: [],
      notFoundBoundary: [],
    } as any;

    await runWithMetrics(metrics, () =>
      runWithRouterContext(minimalRouterCtx(), async () => {
        await resolveSegment(entry, "blog.post", {}, ctx, new Map(), deps);

        // Handler hasn't settled yet — only entry-level timing should be absent
        // (track fires synchronously for non-streamed, but for streamed the
        // handler:blog.post metric should NOT be recorded yet)
        const handlerMetric = metrics.metrics.find(
          (m) => m.label === "handler:blog.post",
        );
        expect(handlerMetric).toBeUndefined();

        // Now settle the handler
        resolveHandler("rendered content");
        await handlerPromise;
        await new Promise((r) => setTimeout(r, 0));

        // Now the handler metric should be recorded
        const recorded = metrics.metrics.find(
          (m) => m.label === "handler:blog.post",
        );
        expect(recorded).toBeDefined();
        expect(recorded!.depth).toBe(2);
        expect(recorded!.duration).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it("records handler timing after streamed parallel promise settles", async () => {
    const metrics = createMetrics();
    const ctx = createContext();
    const deps = createDeps();

    let resolveHandler!: (value: string) => void;
    const handlerPromise = new Promise<string>((resolve) => {
      resolveHandler = resolve;
    });

    const parallelEntry = {
      id: "layout.sidebar",
      type: "parallel",
      shortCode: "L0P0",
      handler: { "@sidebar": () => handlerPromise },
      loading: "sidebar-loading",
      loader: [],
      layout: [],
      parallel: {},
      intercept: [],
      middleware: [],
      revalidate: [],
      errorBoundary: [],
      notFoundBoundary: [],
    } as any;

    await runWithMetrics(metrics, () =>
      runWithRouterContext(minimalRouterCtx(), async () => {
        await resolveParallelEntry(parallelEntry, {}, ctx, false, "L0", deps);

        // Not yet settled
        const before = metrics.metrics.find((m) =>
          m.label.includes("handler:layout.sidebar"),
        );
        expect(before).toBeUndefined();

        resolveHandler("sidebar content");
        await handlerPromise;
        await new Promise((r) => setTimeout(r, 0));

        const after = metrics.metrics.find((m) =>
          m.label.includes("handler:layout.sidebar"),
        );
        expect(after).toBeDefined();
        expect(after!.depth).toBe(2);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Integration: streamed route handler timing via revalidation path
// ---------------------------------------------------------------------------

describe("streamed handler timing — revalidation path", () => {
  it("records handler timing after streamed revalidation route promise settles", async () => {
    const metrics = createMetrics();
    const ctx = createContext();
    const deps = createDeps();

    let resolveHandler!: (value: string) => void;
    const handlerPromise = new Promise<string>((resolve) => {
      resolveHandler = resolve;
    });

    const entry = {
      id: "blog.post",
      type: "route",
      shortCode: "R0",
      handler: () => handlerPromise,
      loading: "loading...",
      loader: [],
      layout: [],
      parallel: {},
      intercept: [],
      middleware: [],
      revalidate: [],
      errorBoundary: [],
      notFoundBoundary: [],
    } as any;

    await runWithMetrics(metrics, () =>
      runWithRouterContext(minimalRouterCtx(), async () => {
        const result = await resolveEntryHandlerWithRevalidation(
          entry,
          {},
          ctx,
          true,
          new Set<string>(), // empty = new segment, always revalidate
          {},
          ctx.request,
          ctx.url,
          ctx.url,
          "blog.post",
          deps,
        );

        // Component should be a Promise (streamed)
        expect(result.segment.component).toBeInstanceOf(Promise);

        // Handler metric should NOT be recorded yet
        const before = metrics.metrics.find(
          (m) => m.label === "handler:blog.post",
        );
        expect(before).toBeUndefined();

        // Settle the handler
        resolveHandler("rendered");
        await handlerPromise;
        await new Promise((r) => setTimeout(r, 0));

        const after = metrics.metrics.find(
          (m) => m.label === "handler:blog.post",
        );
        expect(after).toBeDefined();
        expect(after!.depth).toBe(2);
      }),
    );
  });

  it("records handler timing after streamed revalidation route promise rejects", async () => {
    const metrics = createMetrics();
    const ctx = createContext();
    const deps = createDeps();

    let rejectHandler!: (error: Error) => void;
    const handlerPromise = new Promise<string>((_, reject) => {
      rejectHandler = reject;
    });

    const entry = {
      id: "blog.post",
      type: "route",
      shortCode: "R0",
      handler: () => handlerPromise,
      loading: "loading...",
      loader: [],
      layout: [],
      parallel: {},
      intercept: [],
      middleware: [],
      revalidate: [],
      errorBoundary: [],
      notFoundBoundary: [],
    } as any;

    await runWithMetrics(metrics, () =>
      runWithRouterContext(minimalRouterCtx(), async () => {
        const result = await resolveEntryHandlerWithRevalidation(
          entry,
          {},
          ctx,
          true,
          new Set<string>(),
          {},
          ctx.request,
          ctx.url,
          ctx.url,
          "blog.post",
          deps,
        );

        expect(result.segment.component).toBeInstanceOf(Promise);
        expect(
          metrics.metrics.find((m) => m.label === "handler:blog.post"),
        ).toBeUndefined();

        rejectHandler(new Error("boom"));
        await handlerPromise.catch(() => {});
        await new Promise((r) => setTimeout(r, 0));

        const recorded = metrics.metrics.find(
          (m) => m.label === "handler:blog.post",
        );
        expect(recorded).toBeDefined();
        expect(recorded!.depth).toBe(2);
      }),
    );
  });
});
