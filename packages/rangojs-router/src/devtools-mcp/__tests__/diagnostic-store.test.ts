import { describe, expect, it } from "vitest";
import {
  RANGO_DIAGNOSTIC_BRIDGE_VERSION,
  type DiagnosticBridgeBatch,
} from "../../router/diagnostics/bridge-protocol.js";
import type { DiagnosticEvent } from "../../router/diagnostics/types.js";
import {
  RANGO_MCP_MAX_RESULT_BYTES,
  serializedToolResultBytes,
} from "../protocol.js";
import { createRangoMcpDiagnosticStore } from "../diagnostic-store.js";

function event(
  sequence: number,
  type: string,
  data: Record<string, string | number | boolean | null | string[]> = {},
  requestId = "req-1",
): DiagnosticEvent {
  return {
    schemaVersion: 1,
    sequence,
    type,
    timestamp: 1_000_000_000 + sequence,
    requestId,
    transactionId: `${requestId}-tx`,
    routerId: "app",
    routeKey: "blog.post",
    data,
  };
}

function batch(
  sequence: number,
  events: DiagnosticEvent[],
): DiagnosticBridgeBatch {
  return {
    bridgeVersion: RANGO_DIAGNOSTIC_BRIDGE_VERSION,
    diagnosticSchemaVersion: 1,
    realmId: "realm-1",
    batchSequence: sequence,
    droppedEvents: 0,
    events,
  };
}

function createStore() {
  return createRangoMcpDiagnosticStore({
    instanceId: "00000000-0000-4000-8000-000000000001",
    projectRoot: "/workspace/app",
    getRouteSource: (_routerId, _routeKey, pattern) =>
      pattern === "/blog/:postId"
        ? {
            file: "src/urls/blog.tsx",
            kind: "route",
            precision: "declaration-file",
          }
        : null,
  });
}

describe("Rango MCP diagnostic store", () => {
  it("ingests, selects, and explains one exact request across realm clocks", () => {
    const store = createStore();
    expect(
      store.ingestBridgeBatch(
        batch(1, [
          event(1, "request.started", { method: "GET" }),
          event(2, "request.classified", {
            mode: "full-render",
            transport: "document",
            routePattern: "/blog/:postId",
          }),
          event(3, "error.reported", {
            phase: "loader",
            error: "token=visible authorization=Bearer leaked",
          }),
          event(4, "request.completed", { status: 500, durationMs: 12 }),
        ]),
        10,
        Date.parse("2026-07-14T10:00:00.000Z"),
      ),
    ).toBe(true);

    const requests = store.listRequests({ requestId: "req-1" });
    expect(requests.requests).toEqual([
      expect.objectContaining({
        requestId: "req-1",
        method: "GET",
        transport: "document",
        routePattern: "/blog/:postId",
        status: 500,
        completed: true,
        errorCount: 1,
        source: {
          file: "src/urls/blog.tsx",
          kind: "route",
          precision: "declaration-file",
        },
      }),
    ]);
    expect(requests.stats.acceptedBatches).toBe(1);

    const trace = store.getRequestTrace({ requestId: "req-1" });
    expect(trace.trace.events).toHaveLength(4);
    expect(trace.outputTruncated).toBe(false);

    const errors = store.getErrors({ requestId: "req-1" });
    expect(errors.errors).toHaveLength(1);
    expect(JSON.stringify(errors)).not.toContain("visible");
    expect(JSON.stringify(errors)).not.toContain("leaked");
  });

  it("rejects malformed batches and deduplicates realm batch sequences", () => {
    const store = createStore();
    const valid = batch(1, [event(1, "request.started", { method: "GET" })]);

    expect(store.ingestBridgeBatch(valid)).toBe(true);
    expect(store.ingestBridgeBatch(valid)).toBe(true);
    expect(
      store.ingestBridgeBatch({ ...valid, batchSequence: 2, events: [] }),
    ).toBe(false);
    expect(
      store.ingestBridgeBatch({
        ...valid,
        batchSequence: 2,
        droppedEvents: 1,
        events: [],
      }),
    ).toBe(true);

    expect(store.listRequests().stats).toMatchObject({
      acceptedBatches: 2,
      duplicateBatches: 1,
      rejectedBatches: 1,
      bridgeDroppedEvents: 1,
    });
  });

  it("bounds large trace projections while reporting omitted events", () => {
    const store = createStore();
    for (let batchIndex = 0; batchIndex < 2; batchIndex++) {
      const events = Array.from({ length: 40 }, (_, index) => {
        const sequence = batchIndex * 40 + index + 1;
        return event(sequence, "phase.completed", {
          value: "x".repeat(2_000),
        });
      });
      expect(store.ingestBridgeBatch(batch(batchIndex + 1, events))).toBe(true);
    }

    const result = store.getRequestTrace({ requestId: "req-1" });
    expect(result.outputTruncated).toBe(true);
    expect(result.omittedEvents).toBeGreaterThan(0);
    expect(serializedToolResultBytes(result)).toBeLessThanOrEqual(
      RANGO_MCP_MAX_RESULT_BYTES,
    );
  });

  it("retains current compilation errors, recent warnings, and resolves files", () => {
    const store = createStore();
    const now = Date.now();
    store.setStructuredErrorCapture(true);
    store.recordCompilationIssue({
      severity: "error",
      message: "broken token=visible",
      file: "/workspace/app/src/router.tsx?x=1",
      environment: "rsc",
      line: 10,
      column: 2,
      freshness: "current",
      timestamp: now,
    });
    store.recordCompilationIssue({
      severity: "error",
      message: "replacement compiler failure",
      file: "/workspace/app/src/router.tsx",
      environment: "rsc",
      freshness: "current",
      timestamp: now + 1,
    });
    store.recordCompilationIssue({
      severity: "warning",
      message: "warning",
      freshness: "recent",
      timestamp: now + 2,
    });

    expect(store.getCompilationIssues()).toMatchObject({
      capture: {
        structuredErrors: true,
        warnings: "recent-only",
      },
      issues: [
        expect.objectContaining({ severity: "warning", freshness: "recent" }),
        expect.objectContaining({
          severity: "error",
          message: "replacement compiler failure",
          file: "src/router.tsx",
          freshness: "current",
        }),
      ],
    });
    expect(JSON.stringify(store.getCompilationIssues())).not.toContain(
      "visible",
    );

    store.resolveCompilationFiles(["/workspace/app/src/router.tsx"], "client");
    expect(
      store.getCompilationIssues({ severity: "error" }).issues,
    ).toHaveLength(1);
    store.resolveCompilationFiles(["/workspace/app/src/router.tsx"], "rsc");
    expect(store.getCompilationIssues({ severity: "error" }).issues).toEqual(
      [],
    );
  });

  it("invalidates request cursors when mutable request summaries change", () => {
    const store = createStore();
    store.ingestBridgeBatch(
      batch(1, [
        event(1, "request.started", { method: "GET" }, "req-1"),
        event(2, "request.started", { method: "GET" }, "req-2"),
      ]),
    );
    const first = store.listRequests({ limit: 1 });
    expect(first.nextCursor).not.toBeNull();

    store.ingestBridgeBatch(
      batch(2, [event(3, "request.completed", { status: 200 }, "req-1")]),
    );
    expect(() =>
      store.listRequests({ limit: 1, cursor: first.nextCursor! }),
    ).toThrow("Diagnostic state changed");
  });

  it("preserves current errors when recent-warning capacity is exhausted", () => {
    const store = createStore();
    for (let index = 0; index < 100; index++) {
      store.recordCompilationIssue({
        severity: "error",
        message: `error ${index}`,
        file: `/workspace/app/src/error-${index}.tsx`,
        environment: "rsc",
        freshness: "current",
      });
    }
    store.recordCompilationIssue({
      severity: "warning",
      message: "recent warning",
      freshness: "recent",
    });

    const result = store.getCompilationIssues({ limit: 200 });
    expect(result.issues).toHaveLength(100);
    expect(result.issues.every((issue) => issue.freshness === "current")).toBe(
      true,
    );
    expect(result.droppedIssues).toBe(1);
  });

  it("includes pagination cursors in every result-size bound", () => {
    const store = createRangoMcpDiagnosticStore({
      instanceId: "00000000-0000-4000-8000-000000000001",
      projectRoot: "/workspace/app",
      getRouteSource: () => ({
        file: `src/${"s".repeat(50_000)}.tsx`,
        kind: "route",
        precision: "declaration-file",
      }),
    });
    let batchSequence = 0;
    let eventSequence = 0;
    store.ingestBridgeBatch(
      batch(
        ++batchSequence,
        Array.from({ length: 3 }, (_, index) =>
          event(
            ++eventSequence,
            "request.classified",
            { transport: "document", routePattern: "/large" },
            `request-${index}`,
          ),
        ),
      ),
    );
    store.ingestBridgeBatch(
      batch(
        ++batchSequence,
        Array.from({ length: 3 }, (_, index) =>
          event(
            ++eventSequence,
            "error.reported",
            { error: "e".repeat(5_000) },
            `error-${index}`,
          ),
        ),
      ),
    );
    for (let index = 0; index < 12; index++) {
      store.recordCompilationIssue({
        severity: "warning",
        message: `warning-${index}-${"w".repeat(3_500)}`,
        frame: "f".repeat(8_000),
        freshness: "recent",
      });
    }

    const requests = store.listRequests({ limit: 200 });
    const errors = store.getErrors({ limit: 200 });
    const issues = store.getCompilationIssues({ limit: 200 });
    expect(requests.truncated).toBe(true);
    expect(errors.truncated).toBe(true);
    expect(issues.truncated).toBe(true);
    for (const result of [requests, errors, issues]) {
      expect(serializedToolResultBytes(result)).toBeLessThanOrEqual(
        RANGO_MCP_MAX_RESULT_BYTES,
      );
    }
  });
});
