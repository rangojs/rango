import { describe, expect, it, vi } from "vitest";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";
import { createMetricsStore } from "../../router/metrics.js";
import {
  createRscRenderStages,
  finishRscRenderStages,
  readRscFlightStage,
  runRscRenderStages,
} from "../helpers.js";
import type { RscPayload } from "../types.js";
import type { HandlerContext } from "../handler-context.js";

function payload(pathname: string): RscPayload {
  return {
    metadata: {
      pathname,
      segments: [],
    },
  };
}

function makeCtx(
  renderToReadableStream: HandlerContext["renderToReadableStream"],
): Pick<HandlerContext<unknown>, "renderToReadableStream" | "callOnError"> {
  return {
    renderToReadableStream,
    callOnError: vi.fn(),
  };
}

describe("RSC render stages", () => {
  it("can step payload -> Flight -> final response and resume with overrides", async () => {
    const request = new Request("http://localhost/start");
    const url = new URL(request.url);
    const reqCtx = createRequestContext({
      env: {},
      request,
      url,
      variables: {},
    });
    reqCtx._metricsStore = createMetricsStore(true);
    reqCtx.res.headers.set("x-from-context", "merged");

    const flightStream = new ReadableStream<Uint8Array>();
    const renderToReadableStream = vi.fn(() => flightStream);
    const ctx = makeCtx(renderToReadableStream);
    const firstPayload = payload("/start");
    const nextPayload = payload("/resumed");

    await runWithRequestContext(reqCtx, async () => {
      const stages = createRscRenderStages({
        ctx,
        request,
        env: {},
        url,
        payload: firstPayload,
        init: {
          status: 202,
          headers: { "content-type": "text/x-component;charset=utf-8" },
        },
      });

      const payloadStage = await stages.next();
      expect(payloadStage.done).toBe(false);
      if (payloadStage.done) {
        throw new Error("expected staged payload value");
      }
      expect(payloadStage.value.type).toBe("payload");
      expect(payloadStage.value.payload).toBe(firstPayload);

      const flightStage = await stages.next({
        payload: nextPayload,
        init: {
          status: 203,
          headers: { "x-stage": "flight" },
        },
      });
      expect(flightStage.done).toBe(false);
      if (flightStage.done) {
        throw new Error("expected staged Flight value");
      }
      expect(flightStage.value.type).toBe("flight");
      if (flightStage.value.type !== "flight") {
        throw new Error("expected Flight stage");
      }
      expect(flightStage.value.payload).toBe(nextPayload);
      expect(flightStage.value.stream).toBe(flightStream);
      expect(renderToReadableStream).toHaveBeenCalledWith(
        nextPayload,
        expect.objectContaining({
          onError: expect.any(Function),
        }),
      );

      const responseStage = await stages.next({
        body: "html-body",
        init: {
          status: 201,
          headers: { "content-type": "text/html;charset=utf-8" },
        },
      });
      expect(responseStage.done).toBe(true);
      if (!responseStage.done) {
        throw new Error("expected final response");
      }
      expect(responseStage.value.status).toBe(201);
      expect(responseStage.value.headers.get("content-type")).toBe(
        "text/html;charset=utf-8",
      );
      expect(responseStage.value.headers.get("x-from-context")).toBe("merged");
      expect(await responseStage.value.text()).toBe("html-body");
      expect(reqCtx._metricsStore!.metrics.map((m) => m.label)).toContain(
        "rsc-serialize",
      );
    });
  });

  it("runs to a Flight response without manual stepping", async () => {
    const request = new Request("http://localhost/flight");
    const url = new URL(request.url);
    const reqCtx = createRequestContext({
      env: {},
      request,
      url,
      variables: {},
    });

    const ctx = makeCtx(vi.fn(() => new ReadableStream<Uint8Array>()));

    const response = await runWithRequestContext(reqCtx, () =>
      runRscRenderStages(
        createRscRenderStages({
          ctx,
          request,
          env: {},
          url,
          payload: payload("/flight"),
          init: {
            status: 200,
            headers: { "x-flight": "yes" },
          },
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-flight")).toBe("yes");
  });

  it("can read the Flight stage and finish with a supplied HTML body", async () => {
    const request = new Request("http://localhost/html");
    const url = new URL(request.url);
    const reqCtx = createRequestContext({
      env: {},
      request,
      url,
      variables: {},
    });

    const flightStream = new ReadableStream<Uint8Array>();
    const ctx = makeCtx(vi.fn(() => flightStream));

    const response = await runWithRequestContext(reqCtx, async () => {
      const stages = createRscRenderStages({
        ctx,
        request,
        env: {},
        url,
        payload: payload("/html"),
        init: {
          status: 200,
          headers: { "x-initial": "kept" },
        },
      });

      const flightStage = await readRscFlightStage(stages);
      expect(flightStage.stream).toBe(flightStream);

      return finishRscRenderStages(stages, {
        body: "html",
        init: {
          status: 202,
          headers: { "x-final": "yes" },
        },
      });
    });

    expect(response.status).toBe(202);
    expect(response.headers.get("x-final")).toBe("yes");
    expect(await response.text()).toBe("html");
  });

  it("surfaces synchronous Flight serialization failures at the Flight step", async () => {
    const request = new Request("http://localhost/fail");
    const url = new URL(request.url);
    const reqCtx = createRequestContext({
      env: {},
      request,
      url,
      variables: {},
    });
    const ctx = makeCtx(
      vi.fn(() => {
        throw new Error("serialize failed");
      }),
    );

    await runWithRequestContext(reqCtx, async () => {
      const stages = createRscRenderStages({
        ctx,
        request,
        env: {},
        url,
        payload: payload("/fail"),
        init: { status: 200 },
      });

      const payloadStage = await stages.next();
      expect(payloadStage.done).toBe(false);
      expect(payloadStage.value.type).toBe("payload");
      await expect(stages.next()).rejects.toThrow("serialize failed");
    });
  });
});
