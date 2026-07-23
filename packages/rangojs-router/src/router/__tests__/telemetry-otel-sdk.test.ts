/**
 * Real-SDK contract test for the OTel adapters.
 *
 * The sibling telemetry-otel.test.ts drives createOTelTracing / createOTelSink
 * through a hand-rolled fake tracer, which cannot catch drift against the actual
 * @opentelemetry/api Tracer contract (span nesting via the async context
 * manager, instant-span export, SpanStatusCode values). This file wires the REAL
 * SDK — a BasicTracerProvider with an InMemorySpanExporter and an
 * AsyncLocalStorageContextManager — so the adapters are exercised against the
 * exporter output an OTel consumer would actually collect. No fake tracer here.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { context, SpanStatusCode } from "@opentelemetry/api";
import { createOTelSink, createOTelTracing } from "../telemetry-otel.js";
import { resolveTracing } from "../tracing.js";
import { observePhase, PHASES } from "../instrument.js";
import { runWithRequestContext } from "../../server/request-context.js";

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
// The context manager is what lets startActiveSpan nest child spans under the
// active parent by async context — the exact mechanism createOTelTracing relies
// on. Without it the loader span below would have no parent linkage.
const contextManager = new AsyncLocalStorageContextManager();
const tracer = provider.getTracer("sdk-test");

beforeAll(() => {
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
});

afterAll(async () => {
  context.disable();
  contextManager.disable();
  await provider.shutdown();
});

beforeEach(() => {
  exporter.reset();
});

function spanByName(
  spans: ReadableSpan[],
  name: string,
): ReadableSpan | undefined {
  return spans.find((s) => s.name === name);
}

describe("createOTelTracing phase spans (real SDK)", () => {
  it("nests rango.loader under rango.request via the async context manager", async () => {
    const tracing = resolveTracing(createOTelTracing(tracer))!;
    await runWithRequestContext({ _tracing: tracing } as never, () =>
      observePhase(PHASES.request, async () => {
        await observePhase(PHASES.loader("L1"), async () => {});
      }),
    );

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    const request = spanByName(spans, "rango.request");
    const loader = spanByName(spans, "rango.loader");
    expect(request, "expected a rango.request span").toBeTruthy();
    expect(loader, "expected a rango.loader span").toBeTruthy();
    // The real SDK records the child's parent by span id off the active
    // context; equality proves the adapter's startActiveSpan bridge nests.
    expect(loader!.parentSpanContext?.spanId).toBe(
      request!.spanContext().spanId,
    );
    expect(loader!.attributes["rango.loader_id"]).toBe("L1");
  });

  it("marks the failed phase span ERROR + records the exception, and propagates", async () => {
    const tracing = resolveTracing(createOTelTracing(tracer))!;
    const boom = new Error("loader boom");
    await expect(
      runWithRequestContext({ _tracing: tracing } as never, () =>
        observePhase(PHASES.request, async () => {
          await observePhase(PHASES.loader("L2"), async () => {
            throw boom;
          });
        }),
      ),
    ).rejects.toThrow("loader boom");

    const loader = spanByName(exporter.getFinishedSpans(), "rango.loader");
    expect(loader, "expected a rango.loader span").toBeTruthy();
    expect(loader!.status.code).toBe(SpanStatusCode.ERROR);
    const exceptions = loader!.events.filter((e) => e.name === "exception");
    expect(exceptions).toHaveLength(1);
  });
});

describe("createOTelSink instant spans (real SDK)", () => {
  it("exports rango.cache.decision and an ERROR rango.request.timeout span", () => {
    const sink = createOTelSink(tracer);
    sink.emit({
      type: "cache.decision",
      timestamp: 5,
      pathname: "/blog",
      routeKey: "blog",
      hit: true,
      shouldRevalidate: false,
      source: "runtime",
    });
    sink.emit({
      type: "request.timeout",
      timestamp: 5,
      phase: "action",
      pathname: "/checkout",
      routeKey: "checkout",
      actionId: "submitOrder",
      durationMs: 10000,
      customHandler: true,
    });

    const spans = exporter.getFinishedSpans();
    const decision = spanByName(spans, "rango.cache.decision");
    const timeout = spanByName(spans, "rango.request.timeout");
    expect(decision, "expected a rango.cache.decision span").toBeTruthy();
    expect(decision!.attributes["rango.cache.hit"]).toBe(true);
    expect(decision!.attributes["http.route"]).toBe("/blog");
    expect(timeout, "expected a rango.request.timeout span").toBeTruthy();
    expect(timeout!.status.code).toBe(SpanStatusCode.ERROR);
  });
});
