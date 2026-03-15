import { afterEach, describe, expect, it, vi } from "vitest";
import type { MetricsStore } from "../../server/context.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";
import { handleRscRendering } from "../rsc-rendering.js";
import {
  revalidateAfterAction,
  type ActionContinuation,
} from "../server-action.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function createMetricsStore(): MetricsStore {
  return {
    enabled: true,
    requestStart: performance.now() - 50,
    metrics: [
      {
        label: "route-matching",
        duration: 1,
        startTime: 0,
      },
    ],
  };
}

function createMatchResult() {
  return {
    segments: [],
    matched: ["home"],
    diff: ["home"],
    params: {},
    routeName: "home",
  };
}

function createHandlerContext(matchResult = createMatchResult()) {
  return {
    router: {
      matchPartial: vi.fn(async () => matchResult),
      rootLayout: null,
      themeConfig: null,
      prefetchCacheControl: "private, max-age=300",
      prefetchCacheTTL: 300_000,
    },
    version: "test-version",
    renderToReadableStream: vi.fn(() => new ReadableStream()),
  } as any;
}

function createRequestState(request: Request, metricsStore: MetricsStore) {
  const reqCtx = createRequestContext({
    env: {},
    request,
    url: new URL(request.url),
    variables: {},
  });
  reqCtx._metricsStore = metricsStore;
  return reqCtx;
}

describe("RSC performance metrics recording", () => {
  it("records rsc-serialize and render:total metrics after partial rendering", async () => {
    const request = new Request("http://localhost/home?_rsc_partial=1", {
      headers: { Accept: "text/x-component" },
    });
    const metricsStore = createMetricsStore();
    const reqCtx = createRequestState(request, metricsStore);
    const handlerCtx = createHandlerContext();

    await runWithRequestContext(reqCtx, () =>
      handleRscRendering(
        handlerCtx,
        request,
        {},
        new URL(request.url),
        true,
        reqCtx._handleStore,
        undefined,
      ),
    );

    expect(metricsStore.metrics.map((metric) => metric.label)).toEqual(
      expect.arrayContaining(["rsc-serialize", "render:total"]),
    );
  });

  it("records rsc-serialize and render:total metrics during action revalidation", async () => {
    const request = new Request("http://localhost/home?_rsc_action=save", {
      method: "POST",
      headers: { Accept: "text/x-component" },
    });
    const metricsStore = createMetricsStore();
    const reqCtx = createRequestState(request, metricsStore);
    const handlerCtx = createHandlerContext();
    const continuation: ActionContinuation = {
      returnValue: { ok: true, data: { saved: true } },
      actionStatus: 200,
      temporaryReferences: {} as ActionContinuation["temporaryReferences"],
      actionContext: {
        actionId: "save",
        actionUrl: new URL(request.url),
        actionResult: { saved: true },
      },
    };

    await runWithRequestContext(reqCtx, () =>
      revalidateAfterAction(
        handlerCtx,
        request,
        {},
        new URL(request.url),
        reqCtx._handleStore,
        continuation,
      ),
    );

    expect(metricsStore.metrics.map((metric) => metric.label)).toEqual(
      expect.arrayContaining(["rsc-serialize", "render:total"]),
    );
  });
});
