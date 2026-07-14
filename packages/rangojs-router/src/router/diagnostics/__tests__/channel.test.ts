import { afterEach, describe, expect, it, vi } from "vitest";
import { invokeOnError } from "../../error-handling.js";
import { observePhase, PHASES } from "../../instrument.js";
import {
  flushRevalidationTrace,
  pushRevalidationTraceEntry,
  runWithRouterLogContext,
  startRevalidationTrace,
} from "../../logging.js";
import {
  getRequestIdentity,
  runWithRequestTransaction,
} from "../../request-identity.js";
import { resolveSink, safeEmit } from "../../telemetry.js";
import {
  getDevelopmentDiagnosticHub,
  DiagnosticHub,
  resetDevelopmentDiagnosticHub,
} from "../hub.js";
import {
  recordPhaseStarted,
  recordRequestStarted,
  runWithRequestDiagnostics,
} from "../channel.js";

describe("diagnostic channel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetDevelopmentDiagnosticHub();
  });

  it("records only inside an explicitly enabled request transaction", () => {
    const request = new Request("http://localhost/products?token=secret");

    recordRequestStarted(request, new URL(request.url), "shop");
    expect(getDevelopmentDiagnosticHub()!.listTraces()).toEqual([]);

    runWithRequestTransaction(
      request,
      "request",
      () => recordRequestStarted(request, new URL(request.url), "shop"),
      { routerId: "shop", diagnosticsEnabled: true },
    );

    const trace = getDevelopmentDiagnosticHub()!.listTraces()[0]!;
    expect(trace.events[0].type).toBe("request.started");
    expect(trace.events[0].data).toEqual({
      method: "GET",
      searchNames: ["token"],
    });
    expect(JSON.stringify(trace)).not.toContain("secret");
  });

  it("masks an inherited diagnostic transaction when a nested run disables it", async () => {
    const request = new Request("http://localhost/products");

    await runWithRequestDiagnostics(request, "shop", async () => {
      runWithRouterLogContext(
        {
          request,
          transaction: "shellCapture",
          routerId: "shop",
          diagnosticsEnabled: false,
        },
        () =>
          recordPhaseStarted(PHASES.loader("hidden-loader"), performance.now()),
      );
      return new Response("ok");
    });

    const trace = getDevelopmentDiagnosticHub()!.getTrace(
      getRequestIdentity(request).requestId,
    )!;
    expect(trace.events.map((event) => event.type)).toEqual([
      "request.started",
      "request.completed",
    ]);
  });

  it("redacts retained client correlation values", async () => {
    const request = new Request("http://localhost/products", {
      headers: { "x-request-id": "password=hunter2" },
    });

    await runWithRequestDiagnostics(request, "shop", async () =>
      Response.json({ ok: true }),
    );

    const trace = getDevelopmentDiagnosticHub()!.getTrace(
      getRequestIdentity(request).requestId,
    )!;
    expect(trace.clientCorrelationId).toBe("password=[redacted]");
  });

  it("echoes the request ID when a normal response exposes a null webSocket member", async () => {
    const request = new Request("http://localhost/products");
    const response = new Response("ok");
    Object.defineProperty(response, "webSocket", { value: null });

    const result = await runWithRequestDiagnostics(
      request,
      "shop",
      async () => response,
    );

    expect(result.headers.get("X-Rango-Request-Id")).toBe(
      getRequestIdentity(request).requestId,
    );
  });

  it("does not mutate WebSocket upgrade responses", async () => {
    const request = new Request("http://localhost/socket");
    const response = new Response(null);
    Object.defineProperty(response, "webSocket", { value: {} });

    const result = await runWithRequestDiagnostics(
      request,
      "shop",
      async () => response,
    );

    expect(result).toBe(response);
    expect(result.headers.has("X-Rango-Request-Id")).toBe(false);
  });

  it("fails open when hub insertion or label projection throws", () => {
    const request = new Request("http://localhost/products");
    vi.spyOn(DiagnosticHub.prototype, "record").mockImplementation(() => {
      throw new Error("hub unavailable");
    });

    expect(() =>
      runWithRequestTransaction(
        request,
        "request",
        () => {
          recordRequestStarted(request, new URL(request.url), "shop");
          recordPhaseStarted(
            {
              ...PHASES.request,
              diagnosticLabel: () => {
                throw new Error("untrusted label");
              },
            },
            performance.now(),
          );
        },
        { routerId: "shop", diagnosticsEnabled: true },
      ),
    ).not.toThrow();

    expect(getDevelopmentDiagnosticHub()!.getStats().droppedEvents).toBe(2);
  });

  it("projects phase, error, cache, and revalidation owners without public sinks", async () => {
    const request = new Request("http://localhost/products?view=grid");
    const url = new URL(request.url);

    await runWithRequestTransaction(
      request,
      "request",
      async () => {
        await observePhase(PHASES.loader("catalog#products"), async () => 42);
        invokeOnError(undefined, new Error("loader token=secret"), "loader", {
          request,
          url,
          routeKey: "catalog.products",
          segmentId: "products-loader",
          segmentType: "loader",
          loaderName: "ProductsLoader",
          handledByBoundary: true,
        });
        safeEmit(resolveSink(undefined), {
          type: "cache.decision",
          timestamp: performance.now(),
          requestId: getRequestIdentity(request).requestId,
          pathname: url.pathname,
          routeKey: "catalog.products",
          hit: true,
          shouldRevalidate: false,
          source: "runtime",
        });
        runWithRouterLogContext(
          {
            request,
            transaction: "matchPartial",
            routerId: "shop",
            diagnosticsEnabled: true,
          },
          () => {
            startRevalidationTrace({
              method: "GET",
              prevUrl: "http://localhost/products?view=list",
              nextUrl: url.href,
              routeKey: "catalog.products",
              isAction: false,
            });
            pushRevalidationTraceEntry({
              segmentId: "products-loader",
              segmentType: "loader",
              belongsToRoute: true,
              source: "loader",
              defaultShouldRevalidate: true,
              finalShouldRevalidate: false,
              reason: "custom:false",
            });
            flushRevalidationTrace();
          },
        );
      },
      { routerId: "shop", diagnosticsEnabled: true },
    );

    const requestId = getRequestIdentity(request).requestId;
    const trace = getDevelopmentDiagnosticHub()!.getTrace(requestId)!;
    expect(trace.events.map((event) => event.type)).toEqual([
      "phase.started",
      "phase.completed",
      "error.reported",
      "cache.decision",
      "revalidation.trace",
    ]);
    expect(JSON.stringify(trace)).not.toContain("secret");
    expect(trace.events.at(-1)).toMatchObject({
      transactionId: "matchPartial-tx-2",
      routeKey: "catalog.products",
      data: {
        previousSearchNames: ["view"],
        nextSearchNames: ["view"],
      },
    });
  });
});
