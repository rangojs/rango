import { describe, it, expect, vi } from "vitest";

// Enable debug mode for the logging module
vi.mock("../../internal-debug.js", () => ({
  INTERNAL_RANGO_DEBUG: true,
}));

import {
  runWithRouterLogContext,
  startRevalidationTrace,
  pushRevalidationTraceEntry,
  flushRevalidationTrace,
  type RevalidationTraceEntry,
  type RevalidationTraceMeta,
} from "../logging.js";

function makeMeta(
  overrides?: Partial<RevalidationTraceMeta>,
): RevalidationTraceMeta {
  return {
    method: "GET",
    prevUrl: "http://localhost/a",
    nextUrl: "http://localhost/b",
    routeKey: "test.route",
    isAction: false,
    ...overrides,
  };
}

function makeEntry(
  overrides?: Partial<RevalidationTraceEntry>,
): RevalidationTraceEntry {
  return {
    segmentId: "R0",
    segmentType: "route",
    belongsToRoute: true,
    source: "segment-resolution",
    defaultShouldRevalidate: true,
    finalShouldRevalidate: true,
    reason: "default",
    ...overrides,
  };
}

describe("revalidation trace collector", () => {
  it("returns null when no trace was started", () => {
    const result = flushRevalidationTrace();
    expect(result).toBeNull();
  });

  it("returns null when trace not started inside log context", () => {
    const result = runWithRouterLogContext(
      { request: new Request("http://localhost/"), transaction: "test" },
      () => {
        return flushRevalidationTrace();
      },
    );
    expect(result).toBeNull();
  });

  it("collects and flushes entries within a log context", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = runWithRouterLogContext(
      { request: new Request("http://localhost/"), transaction: "test" },
      () => {
        startRevalidationTrace(makeMeta());
        pushRevalidationTraceEntry(makeEntry({ segmentId: "L0" }));
        pushRevalidationTraceEntry(
          makeEntry({
            segmentId: "R0",
            segmentType: "route",
            finalShouldRevalidate: true,
            reason: "default",
          }),
        );
        return flushRevalidationTrace();
      },
    );

    expect(result).not.toBeNull();
    expect(result!.meta.routeKey).toBe("test.route");
    expect(result!.entries).toHaveLength(2);
    expect(result!.entries[0].segmentId).toBe("L0");
    expect(result!.entries[1].segmentId).toBe("R0");

    consoleSpy.mockRestore();
  });

  it("returns empty entries array when no entries pushed", () => {
    const result = runWithRouterLogContext(
      { request: new Request("http://localhost/"), transaction: "test" },
      () => {
        startRevalidationTrace(makeMeta());
        return flushRevalidationTrace();
      },
    );

    expect(result).not.toBeNull();
    expect(result!.entries).toHaveLength(0);
  });

  it("clears trace after flush", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = runWithRouterLogContext(
      { request: new Request("http://localhost/"), transaction: "test" },
      () => {
        startRevalidationTrace(makeMeta());
        pushRevalidationTraceEntry(makeEntry());
        flushRevalidationTrace();
        return flushRevalidationTrace();
      },
    );

    expect(result).toBeNull();
    consoleSpy.mockRestore();
  });

  it("preserves trace source from each entry", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = runWithRouterLogContext(
      { request: new Request("http://localhost/"), transaction: "test" },
      () => {
        startRevalidationTrace(makeMeta());
        pushRevalidationTraceEntry(
          makeEntry({ source: "loader", segmentId: "L0D0.foo" }),
        );
        pushRevalidationTraceEntry(
          makeEntry({ source: "parallel", segmentId: "L0.@sidebar" }),
        );
        pushRevalidationTraceEntry(
          makeEntry({ source: "cache-hit", segmentId: "L0" }),
        );
        pushRevalidationTraceEntry(
          makeEntry({ source: "orphan-layout", segmentId: "L1" }),
        );
        pushRevalidationTraceEntry(
          makeEntry({ source: "segment-resolution", segmentId: "R0" }),
        );
        return flushRevalidationTrace();
      },
    );

    expect(result!.entries.map((e) => e.source)).toEqual([
      "loader",
      "parallel",
      "cache-hit",
      "orphan-layout",
      "segment-resolution",
    ]);

    consoleSpy.mockRestore();
  });

  it("tracks action context in trace meta", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = runWithRouterLogContext(
      {
        request: new Request("http://localhost/", { method: "POST" }),
        transaction: "test",
      },
      () => {
        startRevalidationTrace(makeMeta({ method: "POST", isAction: true }));
        pushRevalidationTraceEntry(
          makeEntry({
            segmentId: "R0",
            defaultShouldRevalidate: true,
            finalShouldRevalidate: true,
            reason: "default",
          }),
        );
        return flushRevalidationTrace();
      },
    );

    expect(result!.meta.method).toBe("POST");
    expect(result!.meta.isAction).toBe(true);

    consoleSpy.mockRestore();
  });

  it("logs summary with correct revalidated/skipped counts", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    runWithRouterLogContext(
      { request: new Request("http://localhost/"), transaction: "test" },
      () => {
        startRevalidationTrace(makeMeta());
        pushRevalidationTraceEntry(
          makeEntry({ segmentId: "L0", finalShouldRevalidate: false }),
        );
        pushRevalidationTraceEntry(
          makeEntry({ segmentId: "R0", finalShouldRevalidate: true }),
        );
        pushRevalidationTraceEntry(
          makeEntry({ segmentId: "L0D0.x", finalShouldRevalidate: true }),
        );
        flushRevalidationTrace();
      },
    );

    // Find the flush log call
    const flushCall = consoleSpy.mock.calls.find(
      (args) =>
        typeof args[0] === "string" && args[0].includes("revalidation-trace"),
    );
    expect(flushCall).toBeDefined();
    const details = flushCall![1] as any;
    expect(details.total).toBe(3);
    expect(details.revalidated).toBe(2);
    expect(details.skipped).toBe(1);

    consoleSpy.mockRestore();
  });

  it("ignores pushes outside a log context", () => {
    // These should be no-ops without a log context
    startRevalidationTrace(makeMeta());
    pushRevalidationTraceEntry(makeEntry());
    const result = flushRevalidationTrace();
    expect(result).toBeNull();
  });
});
