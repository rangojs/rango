import { describe, it, expect } from "vitest";
import {
  createRequestContext,
  createUseFunction,
  runWithRequestContext,
} from "../request-context.js";
import { createMetricsStore } from "../../router/metrics.js";
import { resolveTracing } from "../../router/tracing.js";
import type { LoaderDefinition } from "../../types.js";

// Drives the REAL request-context ctx.use (createUseFunction) — the unified
// observePhase metering site for that funnel — and pins exactly-once metering:
// one perf metric and one span per loader, even across repeated ctx.use() calls
// (memoization). This complements loader-cache.test.ts (which only proves
// resolveLoaderData adds no metric of its own) by exercising the site that
// actually records.

function makeLoader(id: string): LoaderDefinition<unknown, unknown> {
  return { $$id: id, fn: async () => ({ ok: id }) } as never;
}

function recordingTracing() {
  const spans: string[] = [];
  return {
    spans,
    tracing: resolveTracing({
      runner: (name, fn) => {
        spans.push(name);
        return fn({ setAttribute() {} });
      },
    }),
  };
}

describe("request-context ctx.use loader metering", () => {
  it("records the loader:<id> metric + rango.loader span exactly once across repeated ctx.use()", async () => {
    const request = new Request("http://localhost/");
    const reqCtx = createRequestContext({
      env: {},
      request,
      url: new URL(request.url),
      variables: {},
    });
    const store = createMetricsStore(true)!;
    const { spans, tracing } = recordingTracing();
    reqCtx._metricsStore = store;
    reqCtx._tracing = tracing;

    const use = createUseFunction({
      handleStore: reqCtx._handleStore,
      loaderPromises: new Map(),
      getContext: () => reqCtx,
    });

    const loader = makeLoader("Single#default");

    await runWithRequestContext(reqCtx, async () => {
      const a = use(loader);
      const b = use(loader); // memoized — same promise, no second execution
      expect(a).toBe(b);
      await Promise.all([a, b]);
    });

    expect(
      store.metrics.filter((m) => m.label === "loader:Single#default"),
    ).toHaveLength(1);
    expect(spans.filter((n) => n === "rango.loader")).toHaveLength(1);
    // depth 2 — render-time/handler loaders nest under the render phase.
    expect(
      store.metrics.find((m) => m.label === "loader:Single#default")?.depth,
    ).toBe(2);
  });

  it("still records the loader metric when the loader rejects", async () => {
    const request = new Request("http://localhost/");
    const reqCtx = createRequestContext({
      env: {},
      request,
      url: new URL(request.url),
      variables: {},
    });
    const store = createMetricsStore(true)!;
    reqCtx._metricsStore = store;

    const use = createUseFunction({
      handleStore: reqCtx._handleStore,
      loaderPromises: new Map(),
      getContext: () => reqCtx,
    });

    const loader = {
      $$id: "Boom#default",
      fn: async () => {
        throw new Error("loader failed");
      },
    } as never as LoaderDefinition<unknown, unknown>;

    await runWithRequestContext(reqCtx, async () => {
      await expect(use(loader)).rejects.toThrow("loader failed");
    });

    expect(
      store.metrics.filter((m) => m.label === "loader:Boom#default"),
    ).toHaveLength(1);
  });
});
