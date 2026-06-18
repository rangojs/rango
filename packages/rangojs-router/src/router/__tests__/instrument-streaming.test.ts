import { describe, it, expect } from "vitest";
import {
  observePhase,
  observeRequestPhase,
  observeStreamingPhase,
  PHASES,
} from "../instrument.js";
import { runWithRequestContext } from "../../server/request-context.js";
import { createMetricsStore } from "../metrics.js";
import { resolveTracing, type SpanRunner } from "../tracing.js";

/**
 * Span runner that records span OPEN and END (settle) order, so a test can prove
 * a streaming span ends at body-drain rather than at stream construction. The
 * Cloudflare runner ends the span when its callback settles; this mirrors that.
 */
function lifecycleTracing() {
  const events: string[] = [];
  const runner: SpanRunner = <T>(name: string, fn: (span: never) => T): T => {
    events.push(`open:${name}`);
    const out = fn({ setAttribute() {} } as never);
    if (out instanceof Promise) {
      return out.then(
        (value) => {
          events.push(`end:${name}`);
          return value;
        },
        (error) => {
          events.push(`error:${name}`);
          throw error;
        },
      ) as T;
    }
    events.push(`end:${name}`);
    return out;
  };
  return { events, tracing: resolveTracing({ runner })! };
}

/** A ReadableStream whose chunks and close are driven imperatively by the test. */
function controllableBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (s: string) => controller.enqueue(new TextEncoder().encode(s)),
    close: () => controller.close(),
  };
}

/** Read a response body to completion (drives the drain). */
async function drainBody(res: Response): Promise<void> {
  const reader = res.body!.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}

/** Let queued microtasks (the post-drain span/metric settle) run. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("observeRequestPhase (drain barrier owner)", () => {
  it("delivers the response at construction but ends the span only at body drain", async () => {
    const { events, tracing } = lifecycleTracing();
    const body = controllableBody();

    const res = await runWithRequestContext(
      { _tracing: tracing } as never,
      () =>
        observeRequestPhase(
          PHASES.request,
          async () => new Response(body.stream, { status: 200 }),
        ),
    );

    // Response handed back at construction — streaming is preserved.
    expect(res.status).toBe(200);
    expect(events).toContain("open:rango.request");
    // ...but the span has NOT ended: the body has not drained yet.
    expect(events).not.toContain("end:rango.request");

    // Drain the body; the span settles only now.
    body.push("hello");
    body.close();
    await drainBody(res);
    await flush();
    expect(events).toContain("end:rango.request");
  });

  it("ends the span immediately for a bodyless response (nothing to drain)", async () => {
    const { events, tracing } = lifecycleTracing();
    const res = await runWithRequestContext(
      { _tracing: tracing } as never,
      () =>
        observeRequestPhase(
          PHASES.request,
          async () => new Response(null, { status: 204 }),
        ),
    );
    await flush();
    expect(res.status).toBe(204);
    expect(events).toContain("end:rango.request");
  });

  it("ends the span (no leak) when the client cancels the stream mid-flight", async () => {
    const { events, tracing } = lifecycleTracing();
    const body = controllableBody();
    const res = await runWithRequestContext(
      { _tracing: tracing } as never,
      () =>
        observeRequestPhase(
          PHASES.request,
          async () => new Response(body.stream, { status: 200 }),
        ),
    );
    body.push("partial");
    // Client abandons the read before the body closes.
    await res.body!.cancel("client gone");
    await flush();
    expect(events).toContain("end:rango.request");
  });

  it("is a direct pass-through when neither perf nor tracing is active", async () => {
    const original = new Response("x", { status: 200 });
    const res = await runWithRequestContext({} as never, () =>
      observeRequestPhase(PHASES.request, async () => original),
    );
    // No instrumentation → the exact same Response object (no body re-wrap).
    expect(res).toBe(original);
  });
});

describe("observeStreamingPhase (drain-bound inner phase)", () => {
  it("records the perf metric at construction but ends the span at the request's final drain", async () => {
    const { events, tracing } = lifecycleTracing();
    const store = createMetricsStore(true)!;
    const body = controllableBody();

    let inner!: Promise<string>;
    const res = await runWithRequestContext(
      { _tracing: tracing, _metricsStore: store } as never,
      () =>
        observeRequestPhase(PHASES.request, async () => {
          // A render-like inner streaming phase resolves its value at construction.
          inner = observeStreamingPhase(PHASES.render, async () => "rendered");
          await inner;
          return new Response(body.stream, { status: 200 });
        }),
    );

    // Inner value delivered at construction.
    await expect(inner).resolves.toBe("rendered");
    expect(events).toContain("open:rango.render");
    // The perf metric is recorded at CONSTRUCTION (so it still reaches the
    // Server-Timing header / [RSC Perf] table, both built before the body drains).
    expect(store.metrics.map((m) => m.label)).toContain("render:total");
    // ...but the SPAN has NOT settled yet — it stays open until the body drains.
    expect(events).not.toContain("end:rango.render");

    // Drain → the span settles (the metric was already recorded above).
    body.push("chunk");
    body.close();
    await drainBody(res);
    await flush();
    expect(events).toContain("end:rango.render");
  });

  it("falls back to construction-bound (observePhase) when there is no drain barrier", async () => {
    const { events, tracing } = lifecycleTracing();
    const store = createMetricsStore(true)!;
    // No observeRequestPhase wrapper → no _finalDrain on the context.
    const out = await runWithRequestContext(
      { _tracing: tracing, _metricsStore: store } as never,
      () => observeStreamingPhase(PHASES.render, async () => "v"),
    );
    expect(out).toBe("v");
    // Settled at construction (fn completion), exactly like observePhase.
    expect(events).toContain("end:rango.render");
    expect(store.metrics.map((m) => m.label)).toContain("render:total");
  });

  it("tags the render span with the matched route name (rango.route), resolved after match", async () => {
    // A tracer that captures attributes set on the rango.render span.
    const renderAttrs: Record<string, unknown> = {};
    const runner: SpanRunner = <T>(name: string, fn: (span: never) => T): T =>
      fn({
        setAttribute(key: string, value: unknown) {
          if (name === "rango.render") renderAttrs[key] = value;
        },
      } as never);
    const tracing = resolveTracing({ runner })!;
    const body = controllableBody();

    await runWithRequestContext(
      // _routeName is what match sets; the render phase reads it for rango.route.
      { _tracing: tracing, _routeName: "index" } as never,
      () =>
        observeRequestPhase(PHASES.request, async () => {
          await observeStreamingPhase(PHASES.render, async () => "rendered");
          return new Response(body.stream, { status: 200 });
        }),
    );

    expect(renderAttrs["rango.route"]).toBe("index");
  });

  it("keeps the tree valid: a loader child that settles before drain ends before its drain-bound render parent", async () => {
    const { events, tracing } = lifecycleTracing();
    const body = controllableBody();

    const res = await runWithRequestContext(
      { _tracing: tracing } as never,
      () =>
        observeRequestPhase(PHASES.request, async () => {
          await observeStreamingPhase(PHASES.render, async () => {
            // A loader kicked off during render; it resolves before the body drains
            // (a non-streaming loader). It is a NON-streaming phase → observePhase,
            // ending at its own completion.
            await observePhase(PHASES.loader("L"), async () => "data");
            return "rendered";
          });
          return new Response(body.stream, { status: 200 });
        }),
    );

    // Loader already ended at construction; render has NOT (awaits drain).
    expect(events).toContain("end:rango.loader");
    expect(events).not.toContain("end:rango.render");

    body.push("x");
    body.close();
    await drainBody(res);
    await flush();

    // Render ends at drain — AFTER the loader. Child precedes parent => valid.
    expect(events.indexOf("end:rango.loader")).toBeLessThan(
      events.indexOf("end:rango.render"),
    );
  });
});
