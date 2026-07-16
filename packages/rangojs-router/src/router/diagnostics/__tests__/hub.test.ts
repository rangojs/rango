import { describe, expect, it } from "vitest";
import { DiagnosticHub } from "../hub.js";
import type { DiagnosticEventInput } from "../types.js";

function event(
  requestId: string,
  timestamp: number,
  overrides: Partial<DiagnosticEventInput> = {},
): DiagnosticEventInput {
  return {
    type: "phase.completed",
    timestamp,
    requestId,
    transactionId: `${requestId}-tx-1`,
    routerId: "shop",
    data: { durationMs: 1 },
    ...overrides,
  };
}

describe("DiagnosticHub", () => {
  it("projects transaction IDs and completion into defensive trace copies", () => {
    const hub = new DiagnosticHub();
    hub.record(event("req-1", 1));
    hub.record(
      event("req-1", 2, {
        type: "request.completed",
        transactionId: "match-tx-2",
        data: { status: 200 },
      }),
    );

    const trace = hub.getTrace("req-1", 2)!;
    expect(trace.completed).toBe(true);
    expect(trace.routerId).toBe("shop");
    expect(trace.transactionIds).toEqual(["req-1-tx-1", "match-tx-2"]);

    trace.events.length = 0;
    expect(hub.getTrace("req-1", 2)!.events).toHaveLength(2);
  });

  it("evicts oldest requests and expired traces", () => {
    const hub = new DiagnosticHub({ maxRequests: 2, maxAgeMs: 5 });
    hub.record(event("req-1", 1));
    hub.record(event("req-2", 2));
    hub.record(event("req-3", 3));

    expect(hub.getTrace("req-1", 3)).toBeNull();
    expect(hub.getStats(3).evictedByRequestCount).toBe(1);
    expect(hub.listTraces(9)).toEqual([]);
    expect(hub.getStats(9).evictedByAge).toBe(2);
  });

  it("marks traces when the global event bound drops old evidence", () => {
    const hub = new DiagnosticHub({ maxEvents: 2 });
    hub.record(event("req-1", 1));
    hub.record(event("req-1", 2));
    hub.record(event("req-1", 3));

    const trace = hub.getTrace("req-1", 3)!;
    expect(trace.events).toHaveLength(2);
    expect(trace.truncated).toBe(true);
    expect(trace.truncationReasons).toContain("event-count");
    expect(trace.droppedEvents).toBe(1);
    expect(hub.getStats(3).encodedBytes).toBeGreaterThanOrEqual(
      new TextEncoder().encode(JSON.stringify(trace)).byteLength,
    );
  });

  it("drops an oversized event without exceeding the encoded byte cap", () => {
    const hub = new DiagnosticHub({
      maxEventBytes: 200,
      maxEncodedBytes: 500,
    });
    hub.record(event("req-1", 1, { data: { value: "x".repeat(1_000) } }));

    const trace = hub.getTrace("req-1", 1)!;
    expect(trace.events).toEqual([]);
    expect(trace.truncationReasons).toContain("event-too-large");
    expect(hub.getStats(1).encodedBytes).toBeLessThanOrEqual(500);
  });

  it("attributes producer input drops to their request", () => {
    const hub = new DiagnosticHub({ maxEventBytes: 200 });
    const drops: Array<{ count: number; requestId?: string }> = [];
    hub.subscribeDroppedInputs((count, requestId) => {
      drops.push({ count, requestId });
    });

    hub.record(event("req-1", 1, { data: { value: "x".repeat(1_000) } }));
    hub.noteDroppedEvents(2, "req-1");

    expect(drops).toEqual([
      { count: 1, requestId: "req-1" },
      { count: 2, requestId: "req-1" },
    ]);
    expect(hub.getTrace("req-1", 1)?.droppedEvents).toBe(3);
  });

  it("enforces an encoded byte cap even when trace metadata cannot fit", () => {
    const hub = new DiagnosticHub({ maxEncodedBytes: 1 });
    hub.record(event("req-1", 1));

    expect(hub.getStats(1).encodedBytes).toBeLessThanOrEqual(1);
    expect(hub.getTrace("req-1", 1)).toBeNull();
  });
});
