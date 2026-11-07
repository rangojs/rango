import { describe, expect, it, vi } from "vitest";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";
import { createMetricsStore } from "../../router/metrics.js";
import {
  createRenderStageTraceBridge,
  createRscStageDebugSink,
  createRscRenderPlan,
  driveRscRenderPlan,
  renderRscFlightStage,
  renderRscResponse,
  segmentsThrowingNotFound,
} from "../render-pipeline.js";
import { DataNotFoundError } from "../../errors.js";
import type { ResolvedSegment } from "../../types.js";
import {
  createRoutineTrace,
  runRoutine,
  step,
  type RoutinePlan,
} from "../routine-plan.js";
import type {
  RscRenderCommand,
  RscRenderCommandResult,
  RscRenderStageEvent,
} from "../render-pipeline.js";
import type { HandlerContext } from "../handler-context.js";
import type { RscPayload } from "../types.js";

function payload(pathname: string): RscPayload {
  return { metadata: { pathname, segments: [] } };
}

function makeCtx(
  renderToReadableStream: HandlerContext["renderToReadableStream"],
): Pick<HandlerContext<unknown>, "renderToReadableStream" | "callOnError"> {
  return { renderToReadableStream, callOnError: vi.fn() };
}

function makeInput(
  renderToReadableStream: HandlerContext["renderToReadableStream"],
): {
  input: Parameters<typeof createRscRenderPlan>[0];
  requestContext: ReturnType<typeof createRequestContext>;
} {
  const request = new Request("http://localhost/pipeline");
  const url = new URL(request.url);
  return {
    input: {
      ctx: makeCtx(renderToReadableStream),
      request,
      url,
      env: {},
      payload: payload(url.pathname),
      init: { status: 202, headers: { "x-initial": "yes" } },
    },
    requestContext: createRequestContext({
      env: {},
      request,
      url,
      variables: {},
    }),
  };
}

describe("RSC render pipeline", () => {
  it("yields Flight before serialization executes", () => {
    const renderToReadableStream = vi.fn(
      () => new ReadableStream<Uint8Array>(),
    );
    const { input } = makeInput(renderToReadableStream);

    const plan = createRscRenderPlan(input);
    const first = plan.next();

    expect(first.done).toBe(false);
    if (first.done) throw new Error("expected Flight command");
    expect(first.value.type).toBe("flight");
    expect(renderToReadableStream).not.toHaveBeenCalled();
  });

  it("stamps Flight with the router's captured dev discovery epoch", () => {
    const renderToReadableStream: HandlerContext["renderToReadableStream"] =
      vi.fn(() => new ReadableStream<Uint8Array>());
    const { input } = makeInput(renderToReadableStream);

    renderRscFlightStage({
      ...input,
      ctx: { ...input.ctx, devDiscoveryEpoch: 17 },
    });

    expect(renderToReadableStream).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ devDiscoveryEpoch: 17 }),
      }),
      expect.any(Object),
    );
  });

  it("drives Flight, HTML, and response in order without reading the streams", async () => {
    const flight = new ReadableStream<Uint8Array>();
    const html = new ReadableStream<Uint8Array>();
    const renderToReadableStream = vi.fn(() => flight);
    const renderHtml = vi.fn(
      async (_stream: ReadableStream<Uint8Array>) => html,
    );
    const events: RscRenderStageEvent[] = [];
    const { input, requestContext } = makeInput(renderToReadableStream);

    const response = await runWithRequestContext(requestContext, () =>
      renderRscResponse(
        {
          ...input,
          tracking: {
            mode: "full",
            routeKey: "routes/pipeline",
            onEvent: (event) => events.push(event),
          },
        },
        {
          html: async (stage) => ({
            render: () => renderHtml(stage.stream),
            init: {
              status: 203,
              headers: { "content-type": "text/html;charset=utf-8" },
            },
          }),
        },
      ),
    );

    expect(renderToReadableStream).toHaveBeenCalledOnce();
    expect(renderHtml).toHaveBeenCalledWith(flight);
    expect(response.status).toBe(203);
    expect(response.body).toBe(html);
    expect(response.headers.get("content-type")).toBe(
      "text/html;charset=utf-8",
    );
    expect(
      events.map((event) => `${event.type}:${event.context.phase}`),
    ).toEqual([
      "stage:start:flight",
      "stage:complete:flight",
      "stage:start:html",
      "stage:complete:html",
      "stage:start:response",
      "stage:complete:response",
    ]);
    expect(events.map((event) => event.context.progress.completed)).toEqual([
      0, 1, 1, 2, 2, 3,
    ]);
  });

  it("bridges real render stages beneath the high-level render step", async () => {
    const trace = createRoutineTrace("document");
    const { input, requestContext } = makeInput(
      () => new ReadableStream<Uint8Array>(),
    );
    function* routine(): RoutinePlan<Response> {
      return yield* step("render", () =>
        renderRscResponse({
          ...input,
          tracking: {
            mode: "full",
            onEvent: createRenderStageTraceBridge(trace),
          },
        }),
      );
    }

    await runWithRequestContext(requestContext, () =>
      runRoutine(routine(), { trace, owner: requestContext }),
    );

    expect(
      trace.entries.map(
        (entry) => `${entry.depth}:${entry.kind}:${entry.name}:${entry.state}`,
      ),
    ).toEqual([
      "0:step:render:done",
      "1:step:flight:done",
      "1:step:response:done",
    ]);
  });

  it("attributes a failure to the executing command and preserves Response identity", async () => {
    const thrown = new Response("stop", { status: 409 });
    const events: RscRenderStageEvent[] = [];
    const setAttribute = vi.fn();
    const { input, requestContext } = makeInput(() => {
      throw thrown;
    });

    const caught = await runWithRequestContext(requestContext, async () => {
      try {
        await renderRscResponse({
          ...input,
          tracking: {
            mode: "partial",
            onEvent: (event) => events.push(event),
            span: { setAttribute },
          },
        });
      } catch (error) {
        return error;
      }
    });

    expect(caught).toBe(thrown);
    expect(events.at(-1)).toMatchObject({
      type: "stage:error",
      context: { phase: "flight", progress: { completed: 0, total: 2 } },
      error: thrown,
    });
    expect(setAttribute).toHaveBeenCalledWith("rango.render.mode", "partial");
    expect(setAttribute).toHaveBeenCalledWith(
      "rango.render.error_phase",
      "flight",
    );
  });

  it("closes the plan on failure without replacing the original error", async () => {
    const original = new Error("render failed");
    const cleanup = vi.fn();
    const request = new Request("http://localhost/cleanup");
    const url = new URL(request.url);

    function* plan(): Generator<
      RscRenderCommand<unknown>,
      Response | undefined,
      RscRenderCommandResult
    > {
      try {
        yield {
          type: "response",
          execute: () => {
            throw original;
          },
        };
      } finally {
        cleanup();
      }
      return undefined;
    }

    let caught: unknown;
    try {
      await driveRscRenderPlan(plan(), { url, phases: ["response"] });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(original);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("lets a plan catch a failed command and yield a recovery response", async () => {
    const original = new Error("primary response failed");
    const recovered = new Response("recovered", { status: 503 });
    let caught: unknown;
    const request = new Request("http://localhost/recovery");
    const url = new URL(request.url);

    function* plan(): Generator<
      RscRenderCommand<unknown>,
      Response | undefined,
      RscRenderCommandResult
    > {
      try {
        yield {
          type: "response",
          execute: () => {
            throw original;
          },
        };
      } catch (error) {
        caught = error;
        const result = yield {
          type: "response",
          execute: () => recovered,
        };
        if (result.type !== "response") {
          throw new Error("expected recovery response result");
        }
        return result.value;
      }
      return undefined;
    }

    const response = await driveRscRenderPlan(plan(), {
      url,
      phases: ["response", "response"],
    });

    expect(caught).toBe(original);
    expect(response).toBe(recovered);
  });

  it("attributes HTML preparation failures without starting response finalization", async () => {
    const original = new Error("SSR setup failed");
    const events: RscRenderStageEvent[] = [];
    const { input, requestContext } = makeInput(
      () => new ReadableStream<Uint8Array>(),
    );

    let caught: unknown;
    try {
      await runWithRequestContext(requestContext, () =>
        renderRscResponse(
          {
            ...input,
            tracking: { onEvent: (event) => events.push(event) },
          },
          { html: () => Promise.reject(original) },
        ),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(original);
    expect(events.at(-1)).toMatchObject({
      type: "stage:error",
      context: { phase: "html", progress: { completed: 1, total: 3 } },
      error: original,
    });
    expect(events.map((event) => event.context.phase)).not.toContain(
      "response",
    );
  });

  it("attributes response-constructor failures after Flight completes", async () => {
    const events: RscRenderStageEvent[] = [];
    const { input, requestContext } = makeInput(
      () => new ReadableStream<Uint8Array>(),
    );

    await expect(
      runWithRequestContext(requestContext, () =>
        renderRscResponse({
          ...input,
          init: { status: 99 },
          tracking: { onEvent: (event) => events.push(event) },
        }),
      ),
    ).rejects.toThrow();

    expect(events.at(-1)).toMatchObject({
      type: "stage:error",
      context: { phase: "response", progress: { completed: 1, total: 2 } },
    });
  });

  it("keeps post-construction Flight stream errors outside driver stages", async () => {
    let onStreamError: ((error: unknown) => void) | undefined;
    const { input, requestContext } = makeInput((_payload, options) => {
      onStreamError = options?.onError;
      return new ReadableStream<Uint8Array>();
    });
    const events: RscRenderStageEvent[] = [];

    await runWithRequestContext(requestContext, () =>
      renderRscResponse({
        ...input,
        tracking: { onEvent: (event) => events.push(event) },
      }),
    );
    const streamError = new Error("late stream error");
    onStreamError?.(streamError);

    expect(input.ctx.callOnError).toHaveBeenCalledWith(
      streamError,
      "rendering",
      expect.objectContaining({ request: input.request, url: input.url }),
    );
    expect(events.map((event) => event.type)).not.toContain("stage:error");
  });

  it("does not create stage timestamps when observation is disabled", async () => {
    const now = vi.spyOn(performance, "now");
    const { input, requestContext } = makeInput(
      () => new ReadableStream<Uint8Array>(),
    );

    try {
      await runWithRequestContext(requestContext, () =>
        renderRscResponse({ ...input, recordSerializeMetric: false }),
      );
      expect(now).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it("exposes a request-local foreground cursor only while work is active", async () => {
    let releaseHtml!: (body: BodyInit | null) => void;
    const htmlPending = new Promise<BodyInit | null>((resolve) => {
      releaseHtml = resolve;
    });
    const { input, requestContext } = makeInput(
      () => new ReadableStream<Uint8Array>(),
    );
    requestContext._renderDiagnosticsEnabled = true;

    const pending = runWithRequestContext(requestContext, () =>
      renderRscResponse(
        {
          ...input,
          tracking: { mode: "full", routeKey: "routes/pipeline" },
        },
        {
          html: () => ({ render: () => htmlPending }),
        },
      ),
    );

    await vi.waitFor(() => {
      expect(requestContext._renderForeground).toMatchObject({
        mode: "full",
        phase: "html",
        state: "running",
        completed: 1,
        total: 3,
        routeKey: "routes/pipeline",
      });
    });

    releaseHtml("html");
    await pending;
    expect(requestContext._renderForeground).toBeUndefined();
  });

  it("records Flight serialization once and only when requested", async () => {
    const { input, requestContext } = makeInput(
      () => new ReadableStream<Uint8Array>(),
    );
    const metricsStore = createMetricsStore(true)!;
    requestContext._metricsStore = metricsStore;

    await runWithRequestContext(requestContext, () =>
      renderRscResponse({ ...input, recordSerializeMetric: true }),
    );

    expect(metricsStore.metrics.map((metric) => metric.label)).toEqual([
      "rsc-serialize",
    ]);
  });

  it("keeps specialized direct Flight rendering observable without response ownership", async () => {
    const events: RscRenderStageEvent[] = [];
    const stream = new ReadableStream<Uint8Array>();
    const { input, requestContext } = makeInput(() => stream);

    const stage = await runWithRequestContext(requestContext, () =>
      renderRscFlightStage({
        ...input,
        tracking: {
          mode: "full",
          onEvent: (event) => events.push(event),
        },
      }),
    );

    expect(stage.stream).toBe(stream);
    expect(events.map((event) => event.type)).toEqual([
      "stage:start",
      "stage:complete",
    ]);
    expect(events.at(-1)?.context.progress).toEqual({ completed: 1, total: 1 });
  });

  it("does not let stage sinks alter rendering", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { input, requestContext } = makeInput(
      () => new ReadableStream<Uint8Array>(),
    );

    try {
      const response = await runWithRequestContext(requestContext, () =>
        renderRscResponse({
          ...input,
          tracking: {
            onEvent: () => {
              throw new Error("sink failed");
            },
          },
        }),
      );
      expect(response.status).toBe(202);
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("formats stage events for support logging", () => {
    const log = vi.fn();
    const sink = createRscStageDebugSink(log);
    sink({
      type: "stage:complete",
      durationMs: 1.25,
      context: {
        mode: "partial",
        phase: "flight",
        pathname: "/debug",
        progress: { completed: 1, total: 2 },
        startedAt: 10,
        phaseStartedAt: 12,
        routeKey: "routes/debug",
        actionId: "save",
      },
    });

    expect(log).toHaveBeenCalledWith("[RSC][stage] stage:complete flight", {
      mode: "partial",
      pathname: "/debug",
      routeKey: "routes/debug",
      actionId: "save",
      progress: "1/2",
      durationMs: 1.25,
    });
  });

  it("clears the foreground cursor after a failed render", async () => {
    const thrown = new Error("flight boom");
    const { input, requestContext } = makeInput(() => {
      throw thrown;
    });
    // Enable diagnostics so the driver populates the cursor at all.
    requestContext._renderDiagnosticsEnabled = true;

    await expect(
      runWithRequestContext(requestContext, () =>
        renderRscResponse({ ...input, tracking: { mode: "full" } }),
      ),
    ).rejects.toBe(thrown);

    // A render-start timeout that fires after the driver exits must not read a
    // dead phase as the running render (finding 1).
    expect(requestContext._renderForeground).toBeUndefined();
  });

  it("never reports completed beyond total when phases undercount the plan", async () => {
    const events: RscRenderStageEvent[] = [];
    const request = new Request("http://localhost/clamp");
    const url = new URL(request.url);

    function* twoResponses(): Generator<
      RscRenderCommand<unknown>,
      Response | undefined,
      RscRenderCommandResult
    > {
      const r1 = yield {
        type: "response",
        execute: () => new Response("a", { status: 201 }),
      };
      if (r1.type !== "response") throw new Error("expected response");
      const r2 = yield {
        type: "response",
        execute: () => new Response("b", { status: 202 }),
      };
      if (r2.type !== "response") throw new Error("expected response");
      return r2.value;
    }

    // Declare only one phase for a two-command plan: total must clamp up to the
    // real command count so progress never emits `2/1` (finding 5).
    const response = await driveRscRenderPlan(twoResponses(), {
      url,
      phases: ["response"],
      tracking: { onEvent: (event) => events.push(event) },
    });

    expect(response.status).toBe(202);
    for (const event of events) {
      expect(event.context.progress.completed).toBeLessThanOrEqual(
        event.context.progress.total,
      );
    }
    expect(events.at(-1)?.context.progress).toEqual({
      completed: 2,
      total: 2,
    });
  });
});

describe("a redirect React caught while rendering", () => {
  const thrown = () =>
    new Response(null, { status: 302, headers: { Location: "/target" } });

  /** A Flight render that reports `error` before its opening chunk. */
  function renderThatReports(error: unknown) {
    return vi.fn(
      (_payload: unknown, options?: { onError?: (error: unknown) => void }) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            options?.onError?.(error);
            controller.enqueue(new TextEncoder().encode("0:shell\n"));
            controller.close();
          },
        }),
    );
  }

  it("answers the caller's redirect instead of a 200 Flight response", async () => {
    const error = thrown();
    const { input, requestContext } = makeInput(renderThatReports(error));

    const response = await runWithRequestContext(requestContext, () =>
      renderRscResponse(
        { ...input, init: { status: 200 } },
        {
          redirect: (caught) =>
            new Response(null, {
              status: 307,
              headers: { Location: caught.headers.get("Location")! },
            }),
        },
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/target");
    expect(response.body).toBeNull();
    // The render's error is recorded once, by the Flight onError it came from.
    expect(requestContext._renderErrors).toEqual([error]);
  });

  it("replays the opening chunk to the client when the render threw nothing", async () => {
    const { input, requestContext } = makeInput(
      () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("0:shell\n"));
            controller.enqueue(new TextEncoder().encode("1:page\n"));
            controller.close();
          },
        }),
    );

    const response = await runWithRequestContext(requestContext, () =>
      renderRscResponse(
        { ...input, init: { status: 200 } },
        {
          redirect: () => new Response(null, { status: 302 }),
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("0:shell\n1:page\n");
  });

  it("ignores an error an earlier pass of the request left in the list", async () => {
    const earlier = thrown();
    const { input, requestContext } = makeInput(
      () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("0:shell\n"));
            controller.close();
          },
        }),
    );
    requestContext._renderErrors = [earlier];

    const response = await runWithRequestContext(requestContext, () =>
      renderRscResponse(
        { ...input, init: { status: 200 } },
        {
          redirect: () => new Response(null, { status: 302 }),
        },
      ),
    );

    expect(response.status).toBe(200);
  });

  it("answers a document's redirect before the response is built", async () => {
    const error = thrown();
    let report!: (error: unknown) => void;
    const { input, requestContext } = makeInput(
      (_payload: unknown, options?: { onError?: (error: unknown) => void }) => {
        report = options!.onError!;
        return new ReadableStream<Uint8Array>();
      },
    );
    let cancelled = false;
    const htmlBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<html></html>"));
      },
      cancel() {
        cancelled = true;
      },
    });

    const response = await runWithRequestContext(requestContext, () =>
      renderRscResponse(
        { ...input, init: { status: 200 } },
        {
          // The HTML step decodes the payload, which is when React reports what
          // the render threw.
          html: async () => ({
            render: () => {
              report(error);
              return htmlBody;
            },
          }),
          redirect: () => new Response(null, { status: 303 }),
        },
      ),
    );

    expect(response.status).toBe(303);
    expect(cancelled).toBe(true);
  });

  it("keeps the response when the redirect arrives after the opening chunk", async () => {
    const error = thrown();
    const { input, requestContext } = makeInput(
      (_payload: unknown, options?: { onError?: (error: unknown) => void }) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("0:shell\n"));
            // The redirect surfaces only once the client is already reading the
            // body: the status line has committed by then.
            setTimeout(() => {
              options?.onError?.(error);
              controller.enqueue(new TextEncoder().encode("1:E{}\n"));
              controller.close();
            }, 0);
          },
        }),
    );

    const response = await runWithRequestContext(requestContext, () =>
      renderRscResponse(
        { ...input, init: { status: 200 } },
        {
          redirect: () => new Response(null, { status: 302 }),
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("0:shell\n1:E{}\n");
  });

  it("the cancel of a render it answered is not reported as a rendering error", async () => {
    const aborted = new DOMException(
      "This operation was aborted",
      "AbortError",
    );
    let cancelled = false;
    const render = vi.fn(
      (_payload: unknown, options?: { onError?: (error: unknown) => void }) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            options?.onError?.(thrown());
            controller.enqueue(new TextEncoder().encode("0:shell\n"));
          },
          cancel() {
            cancelled = true;
            options?.onError?.(aborted);
          },
        }),
    );
    const { input, requestContext } = makeInput(render);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await runWithRequestContext(requestContext, () =>
      renderRscResponse(
        { ...input, init: { status: 200 } },
        { redirect: () => new Response(null, { status: 302 }) },
      ),
    );

    expect(response.status).toBe(302);
    await vi.waitFor(() => expect(cancelled).toBe(true));
    expect(input.ctx.callOnError).not.toHaveBeenCalled();
    expect(requestContext._renderErrors ?? []).not.toContain(aborted);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("leaves a Flight response unread when the caller answers no redirect", async () => {
    const stream = new ReadableStream<Uint8Array>();
    const { input, requestContext } = makeInput(() => stream);

    const response = await runWithRequestContext(requestContext, () =>
      renderRscResponse({ ...input, init: { status: 200 } }),
    );

    expect(response.body).toBe(stream);
  });
});

describe("which segments' components throw notFound()", () => {
  const segment = (id: string, component: unknown = id): ResolvedSegment => ({
    id,
    namespace: id,
    type: "layout",
    index: 0,
    component: component as ResolvedSegment["component"],
  });
  const chunk = new TextEncoder().encode("0:row\n");
  /** The not-founds the response's render reported, by message. */
  const reported = (...messages: string[]) =>
    messages.map((message) => new DataNotFoundError(message));

  /**
   * A probe render: each node is a segment's id, `script[id]` what its render
   * does — report a not-found before its opening chunk ("sync"), after it
   * ("late"), or nothing — and `open` keeps the stream from ever closing.
   */
  function probeRender(
    script: Record<string, "sync" | "late" | undefined>,
    open: ReadonlySet<string> = new Set(),
  ) {
    const cancelled: string[] = [];
    const rendered: string[] = [];
    const render = (node: unknown, onError: (error: unknown) => void) => {
      const id = node as string;
      rendered.push(id);
      let live = true;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          if (script[id] === "sync") onError(new DataNotFoundError(id));
          onError(new Error("not a not-found"));
          controller.enqueue(chunk);
          setTimeout(() => {
            if (script[id] === "late") onError(new DataNotFoundError(id));
            if (live && !open.has(id)) controller.close();
          }, 0);
        },
        cancel() {
          live = false;
          cancelled.push(id);
        },
      });
    };
    return { render, cancelled, rendered };
  }

  it("names each segment whose own render throws, in payload order, with its error", async () => {
    const { render, rendered } = probeRender({ route: "sync", layout: "sync" });
    const throwers = await segmentsThrowingNotFound(
      [
        segment("root"),
        segment("layout"),
        segment("empty", null),
        segment("route"),
      ],
      render,
      reported("layout", "route"),
      "opened",
    );
    expect(throwers.map((t) => t.segment.id)).toEqual(["layout", "route"]);
    expect(throwers.map((t) => t.error.message)).toEqual(["layout", "route"]);
    expect(rendered).toEqual(["root", "layout", "route"]);
  });

  it("stops once it has as many as the response's render, whatever still streams", async () => {
    const { render, cancelled } = probeRender(
      { route: "sync" },
      new Set(["root", "route"]),
    );
    const throwers = await segmentsThrowingNotFound(
      [segment("root"), segment("route")],
      render,
      reported("route"),
      "ended",
    );
    expect(throwers.map((t) => t.segment.id)).toEqual(["route"]);
    expect(cancelled.sort()).toEqual(["root", "route"]);
  });

  it("a Flight response's probes stop at their opening chunk: a later throw is not its render's", async () => {
    const { render } = probeRender({ route: "late" }, new Set(["route"]));
    const throwers = await segmentsThrowingNotFound(
      [segment("route")],
      render,
      reported("route"),
      "opened",
    );
    expect(throwers).toEqual([]);
  });

  it("a document's probes run on to their end, as its html step did", async () => {
    const { render } = probeRender({ layout: "late" });
    const throwers = await segmentsThrowingNotFound(
      [segment("layout"), segment("route")],
      render,
      reported("layout"),
      "ended",
    );
    expect(throwers.map((t) => t.segment.id)).toEqual(["layout"]);
  });

  it("a probe that cannot render is skipped, the others still answer", async () => {
    const { render } = probeRender({ route: "sync" });
    const throwers = await segmentsThrowingNotFound(
      [segment("broken"), segment("route")],
      (node, onError) => {
        if (node === "broken") throw new Error("cannot render");
        return render(node, onError);
      },
      reported("route"),
      "ended",
    );
    expect(throwers.map((t) => t.segment.id)).toEqual(["route"]);
  });

  it("a not-found the response's render did not report is not taken for one it did", async () => {
    const { render } = probeRender({ route: "sync", layout: "late" });
    const throwers = await segmentsThrowingNotFound(
      [segment("layout"), segment("route")],
      render,
      reported("layout"),
      "ended",
    );
    expect(throwers.map((t) => t.segment.id)).toEqual(["layout"]);
  });

  it("a component that does not throw again is not named", async () => {
    const { render } = probeRender({});
    const throwers = await segmentsThrowingNotFound(
      [segment("layout"), segment("route")],
      render,
      reported("layout"),
      "ended",
    );
    expect(throwers).toEqual([]);
  });
});
