import { describe, expect, it, vi } from "vitest";
import { RANGO_DIAGNOSTIC_BRIDGE_EVENT } from "../bridge-protocol.js";
import { DiagnosticHub } from "../hub.js";
import {
  connectDiagnosticRuntimeBridge,
  type DiagnosticRuntimeHotContext,
} from "../runtime-bridge.js";

function record(hub: DiagnosticHub, index: number): void {
  hub.record({
    type: "phase.completed",
    timestamp: index,
    requestId: `req-${index}`,
    transactionId: `tx-${index}`,
    routerId: "app",
    data: { durationMs: index },
  });
}

function createHot() {
  const send = vi.fn<(event: string, data: unknown) => void>();
  return {
    data: {},
    send,
    dispose: vi.fn(),
  } satisfies DiagnosticRuntimeHotContext;
}

describe("diagnostic runtime bridge", () => {
  it("batches accepted hub events onto the development hot channel", async () => {
    const hub = new DiagnosticHub();
    const hot = createHot();
    const cleanup = connectDiagnosticRuntimeBridge(hot, hub, "realm-1");

    record(hub, 1);
    record(hub, 2);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(hot.send).toHaveBeenCalledOnce();
    expect(hot.send).toHaveBeenCalledWith(
      RANGO_DIAGNOSTIC_BRIDGE_EVENT,
      expect.objectContaining({
        realmId: "realm-1",
        batchSequence: 1,
        droppedEvents: 0,
        events: [
          expect.objectContaining({ requestId: "req-1" }),
          expect.objectContaining({ requestId: "req-2" }),
        ],
      }),
    );

    cleanup();
    record(hub, 3);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(hot.send).toHaveBeenCalledOnce();
  });

  it("drops oldest queued evidence instead of blocking requests", async () => {
    const hub = new DiagnosticHub({ maxRequests: 1_000, maxEvents: 1_000 });
    const hot = createHot();
    connectDiagnosticRuntimeBridge(hot, hub, "realm-1");

    for (let index = 0; index < 257; index++) record(hub, index);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    const batches = hot.send.mock.calls.map((call) => call[1]) as Array<{
      droppedEvents: number;
      events: Array<{ requestId: string }>;
    }>;
    expect(batches.flatMap((batch) => batch.events)).toHaveLength(256);
    expect(batches[0]!.droppedEvents).toBe(1);
    expect(batches[0]!.events[0]!.requestId).toBe("req-1");
  });

  it("reports hub input drops and preserves them across a failed send", async () => {
    const hub = new DiagnosticHub({
      maxRequests: 1_000,
      maxEvents: 1_000,
      maxEventBytes: 300,
    });
    const hot = createHot();
    hot.send.mockImplementationOnce(() => {
      throw new Error("hot channel unavailable");
    });
    connectDiagnosticRuntimeBridge(hot, hub, "realm-1");

    hub.record({
      type: "phase.completed",
      timestamp: 0,
      requestId: "oversized",
      transactionId: "oversized-tx",
      routerId: "app",
      data: { value: "x".repeat(1_000) },
    });
    for (let index = 0; index < 65; index++) record(hub, index + 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 75));

    expect(hot.send).toHaveBeenCalledTimes(2);
    expect(hot.send.mock.calls[1]![1]).toMatchObject({ droppedEvents: 65 });
  });

  it("retries a failed final send as a drop-only batch", async () => {
    const hub = new DiagnosticHub();
    const hot = createHot();
    hot.send.mockImplementationOnce(() => {
      throw new Error("hot channel unavailable");
    });
    connectDiagnosticRuntimeBridge(hot, hub, "realm-1");

    record(hub, 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 75));

    expect(hot.send).toHaveBeenCalledTimes(2);
    expect(hot.send.mock.calls[1]![1]).toMatchObject({
      droppedEvents: 1,
      events: [],
    });
  });
});
