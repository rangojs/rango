import { describe, it, expect } from "vitest";
import { revalidateAfterAction } from "../server-action.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";
import { createMetricsStore } from "../../router/metrics.js";
import { resolveTracing } from "../../router/tracing.js";

/** A Flight body with one opening chunk: the plan holds it (render-pipeline.ts). */
function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

// An action's revalidation render used to open NO rango.render span and recorded
// render:total directly, so its revalidation loaders' rango.loader spans dangled
// at the request root. revalidateAfterAction now wraps the render in
// observePhase(PHASES.render), co-emitting the span + metric exactly like a
// normal navigation render (handleRscRendering). This pins both surfaces.

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

function makeCtx() {
  return {
    version: "v-test",
    callOnError: () => {},
    // One opening chunk: the plan holds it before it can answer a redirect
    // (render-pipeline.ts createRscRenderPlan), and a stream that never
    // enqueues would hold the response forever.
    renderToReadableStream: () => streamOf("0:shell\n"),
    router: {
      id: "test",
      async matchPartial() {
        return {
          segments: [],
          matched: [],
          diff: [],
          resolvedIds: [],
          params: {},
          routeName: "home",
          slots: undefined,
        };
      },
    },
  } as never;
}

describe("revalidateAfterAction tracing", () => {
  it("co-emits rango.render span + render:total metric for the revalidation render", async () => {
    const { spans, tracing } = recordingTracing();
    const request = new Request("http://localhost/?_rsc_partial=1");
    const reqCtx = createRequestContext({
      env: {},
      request,
      url: new URL(request.url),
      variables: {},
    });
    reqCtx._tracing = tracing;
    reqCtx._metricsStore = createMetricsStore(true);

    const handleStore = { stream: () => ({}) } as never;
    const continuation = {
      returnValue: { ok: true, data: undefined },
      actionStatus: 200,
      temporaryReferences: undefined,
      actionContext: {},
    } as never;

    await runWithRequestContext(reqCtx, () =>
      revalidateAfterAction(
        makeCtx(),
        request,
        {},
        new URL(request.url),
        handleStore,
        continuation,
      ),
    );

    expect(spans).toContain("rango.render");
    // The render metric label carries the resolved route name (matchPartial
    // returned routeName "home" above).
    expect(reqCtx._metricsStore!.metrics.map((m) => m.label)).toContain(
      "render:total:home",
    );
  });
});
