import { describe, it, expect, vi } from "vitest";

// A capture that waited past the queue budget is dropped unrun: outcome
// skip-queue-timeout on the debug event AND the rango.background span, the
// in-flight key is released (a later request can reschedule), and the key is
// NOT backed off (the route is not doomed — the isolate was busy).

// Replace only enqueueSerializedCapture; keep the real error classes so
// shell-capture's instanceof checks see the same identities.
vi.mock("../capture-queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../capture-queue.js")>();
  return {
    ...actual,
    enqueueSerializedCapture: vi.fn(() =>
      Promise.reject(new actual.CaptureQueueWaitTimeoutError(20_000)),
    ),
  };
});

vi.mock("../../cache/segment-codec.js", () => ({
  serializeResult: vi.fn(async (v: unknown) => JSON.stringify(v)),
  deserializeResult: vi.fn(async (v: string) => JSON.parse(v)),
}));

import {
  scheduleShellCapture,
  isCaptureBackedOff,
  type ShellCaptureDebugEvent,
} from "../shell-capture.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import { resolveTracing } from "../../router/tracing.js";
import type { HandlerContext } from "../handler-context.js";
import type { SSRModule } from "../types.js";

describe("scheduleShellCapture queue-wait timeout", () => {
  it("publishes skip-queue-timeout, tags the span, releases the key, and skips backoff", async () => {
    const key = "/queue-skip:shell";
    const events: ShellCaptureDebugEvent[] = [];
    const captured: Array<() => Promise<void>> = [];
    const spans: Array<{
      name: string;
      attributes: Record<string, unknown>;
    }> = [];

    const reqCtx = createRequestContext({
      env: {},
      request: new Request("http://localhost/q"),
      url: new URL("http://localhost/q"),
      variables: {},
    }) as RequestContext;
    (reqCtx as any)._tracing = resolveTracing({
      runner: (name, fn) => {
        const record = { name, attributes: {} as Record<string, unknown> };
        spans.push(record);
        return fn({
          setAttribute(k, v) {
            record.attributes[k] = v;
          },
        });
      },
    });
    (reqCtx as any).waitUntil = (task: () => Promise<void>) => {
      captured.push(task);
    };

    const ctx = { version: "v-test" } as unknown as HandlerContext<any>;
    const ssrModule = {
      renderHTML: vi.fn(),
      resumeShellHTML: vi.fn(),
      captureShellHTML: vi.fn(),
    } as unknown as SSRModule;
    const descriptor = {
      key,
      buildVersion: "test-build",
      store: { putShell: vi.fn() } as any,
      debugSink: (e: ShellCaptureDebugEvent) => events.push(e),
    };

    scheduleShellCapture(
      ctx,
      new Request("http://localhost/q"),
      {},
      new URL("http://localhost/q"),
      reqCtx,
      ssrModule,
      descriptor,
    );
    expect(captured).toHaveLength(1);
    await runWithRequestContext(reqCtx as any, () => captured[0]!());

    expect(events.map((e) => e.outcome)).toEqual(["skip-queue-timeout"]);
    expect(events[0].queueWaitMs).toBe(20_000);
    // The capture never ran.
    expect(ssrModule.captureShellHTML).not.toHaveBeenCalled();

    expect(spans.map((s) => s.name)).toEqual(["rango.background"]);
    expect(spans[0].attributes["rango.background.outcome"]).toBe(
      "skip-queue-timeout",
    );
    expect(spans[0].attributes["rango.background.queue_wait_ms"]).toBe(20_000);

    // No backoff, and the in-flight key was released: a later schedule for
    // the same key is admitted again (not skip-in-flight).
    expect(isCaptureBackedOff(key)).toBe(false);
    scheduleShellCapture(
      ctx,
      new Request("http://localhost/q"),
      {},
      new URL("http://localhost/q"),
      reqCtx,
      ssrModule,
      descriptor,
    );
    expect(captured).toHaveLength(2);
    await runWithRequestContext(reqCtx as any, () => captured[1]!());
  });
});
