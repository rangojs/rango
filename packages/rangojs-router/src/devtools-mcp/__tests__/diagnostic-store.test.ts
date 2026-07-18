import { describe, expect, it, vi } from "vitest";
import {
  RANGO_DIAGNOSTIC_BRIDGE_VERSION,
  type DiagnosticBridgeBatch,
} from "../../router/diagnostics/bridge-protocol.js";
import type { BrowserNavigationEvent } from "../../router/diagnostics/browser-protocol.js";
import type {
  DiagnosticEvent,
  DiagnosticValue,
} from "../../router/diagnostics/types.js";
import {
  RANGO_MCP_MAX_RESULT_BYTES,
  serializedToolResultBytes,
} from "../protocol.js";
import { createRangoMcpDiagnosticStore } from "../diagnostic-store.js";

function event(
  sequence: number,
  type: string,
  data: Record<string, DiagnosticValue> = {},
  requestId = "req-1",
): DiagnosticEvent {
  return {
    schemaVersion: 1,
    sequence,
    type,
    timestamp: 1_000_000_000 + sequence,
    requestId,
    transactionId: `${requestId}-tx`,
    routerId: "app",
    routeKey: "blog.post",
    data,
  };
}

function batch(
  sequence: number,
  events: DiagnosticEvent[],
): DiagnosticBridgeBatch {
  return {
    bridgeVersion: RANGO_DIAGNOSTIC_BRIDGE_VERSION,
    diagnosticSchemaVersion: 1,
    realmId: "realm-1",
    batchSequence: sequence,
    droppedEvents: 0,
    droppedEventsByRequest: [],
    events,
  };
}

function createStore() {
  return createRangoMcpDiagnosticStore({
    instanceId: "00000000-0000-4000-8000-000000000001",
    projectRoot: "/workspace/app",
    getRouteSource: (_routerId, _routeKey, pattern) =>
      pattern === "/blog/:postId"
        ? {
            file: "src/urls/blog.tsx",
            kind: "route",
            precision: "declaration-file",
          }
        : null,
  });
}

function navigationEvent(
  sequence: number,
  phase: BrowserNavigationEvent["phase"],
  requestId?: string,
  overrides: Partial<BrowserNavigationEvent> = {},
): BrowserNavigationEvent {
  return {
    version: 1,
    sequence,
    documentId: "doc-00000000-0000-4000-8000-000000000001",
    navigationId: "nav-00000000-0000-4000-8000-000000000002",
    kind: "navigate",
    phase,
    pathname: "/blog/first",
    ...(requestId ? { requestId, role: "navigation" } : {}),
    ...overrides,
  };
}

describe("Rango MCP diagnostic store", () => {
  it("ingests, selects, and explains one exact request across realm clocks", () => {
    const store = createStore();
    expect(
      store.ingestBridgeBatch(
        batch(1, [
          event(1, "request.started", { method: "GET" }),
          event(2, "request.classified", {
            mode: "full-render",
            transport: "document",
            routePattern: "/blog/:postId",
          }),
          event(3, "error.reported", {
            phase: "loader",
            error: "token=visible authorization=Bearer leaked",
          }),
          event(4, "request.completed", { status: 500, durationMs: 12 }),
        ]),
        10,
        Date.parse("2026-07-14T10:00:00.000Z"),
      ),
    ).toBe(true);

    const requests = store.listRequests({ requestId: "req-1" });
    expect(requests.requests).toEqual([
      expect.objectContaining({
        requestId: "req-1",
        method: "GET",
        transport: "document",
        routePattern: "/blog/:postId",
        status: 500,
        completed: true,
        errorCount: 1,
        source: {
          file: "src/urls/blog.tsx",
          kind: "route",
          precision: "declaration-file",
        },
      }),
    ]);
    expect(requests.stats.acceptedBatches).toBe(1);

    const trace = store.getRequestTrace({ requestId: "req-1" });
    expect(trace.trace.events).toHaveLength(4);
    expect(trace.outputTruncated).toBe(false);

    const errors = store.getErrors({ requestId: "req-1" });
    expect(errors.errors).toHaveLength(1);
    expect(JSON.stringify(errors)).not.toContain("visible");
    expect(JSON.stringify(errors)).not.toContain("leaked");
  });

  it("rejects malformed batches and deduplicates realm batch sequences", () => {
    const store = createStore();
    const valid = batch(1, [event(1, "request.started", { method: "GET" })]);

    expect(store.ingestBridgeBatch(valid)).toBe(true);
    expect(store.ingestBridgeBatch(valid)).toBe(true);
    expect(
      store.ingestBridgeBatch({ ...valid, batchSequence: 2, events: [] }),
    ).toBe(false);
    expect(
      store.ingestBridgeBatch({
        ...valid,
        batchSequence: 2,
        droppedEvents: 1,
        droppedEventsByRequest: [],
        events: [],
      }),
    ).toBe(true);

    expect(store.listRequests().stats).toMatchObject({
      acceptedBatches: 2,
      duplicateBatches: 1,
      rejectedBatches: 1,
      bridgeDroppedEvents: 1,
    });
  });

  it("accepts out-of-order realm batches once", () => {
    const store = createStore();
    const later = batch(2, [
      event(2, "request.completed", { status: 200 }, "req-1"),
    ]);
    const earlier = batch(1, [
      event(1, "request.started", { method: "GET" }, "req-1"),
    ]);

    expect(store.ingestBridgeBatch(later)).toBe(true);
    expect(store.ingestBridgeBatch(earlier)).toBe(true);
    expect(store.ingestBridgeBatch(earlier)).toBe(true);

    expect(store.listRequests()).toMatchObject({
      requests: [expect.objectContaining({ requestId: "req-1" })],
      stats: {
        acceptedBatches: 2,
        duplicateBatches: 1,
      },
    });
    expect(
      store
        .getRequestTrace({ requestId: "req-1" })
        .trace.events.map((item) => item.type),
    ).toEqual(["request.started", "request.completed"]);
  });

  it("rejects reordered batches beyond the bounded window", () => {
    const store = createStore();

    expect(
      store.ingestBridgeBatch(
        batch(258, [event(1, "request.started", { method: "GET" })]),
      ),
    ).toBe(false);
    expect(store.listRequests().stats).toMatchObject({
      acceptedBatches: 0,
      rejectedBatches: 1,
    });
  });

  it("recovers after a missing realm batch without blocking later evidence", async () => {
    vi.useFakeTimers();
    try {
      const store = createStore();
      expect(
        store.ingestBridgeBatch(
          batch(2, [event(2, "request.completed", { status: 200 })]),
        ),
      ).toBe(true);
      expect(store.listRequests().requests).toEqual([]);

      await vi.advanceTimersByTimeAsync(250);

      expect(store.listRequests().requests).toEqual([
        expect.objectContaining({
          requestId: "req-1",
          completed: true,
          truncated: true,
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("attributes bridge loss to retained request traces", () => {
    const store = createStore();
    const lossyBatch = batch(1, [
      event(1, "request.started", { method: "GET" }),
      event(2, "revalidation.trace", {
        entries: [],
        entriesTruncated: false,
      }),
    ]);
    lossyBatch.droppedEvents = 2;
    lossyBatch.droppedEventsByRequest = [
      { requestId: "req-1", droppedEvents: 1 },
    ];

    expect(store.ingestBridgeBatch(lossyBatch)).toBe(true);
    expect(store.listRequests().requests[0]).toMatchObject({
      requestId: "req-1",
      droppedEvents: 1,
      truncated: true,
    });
    expect(store.getRequestTrace({ requestId: "req-1" }).trace).toMatchObject({
      droppedEvents: 1,
    });
    expect(store.explainRender({ requestId: "req-1" }).truncated).toBe(true);
    expect(store.explainCacheTags({ requestId: "req-1" }).truncated).toBe(true);
    expect(store.explainRevalidation({ requestId: "req-1" }).truncated).toBe(
      true,
    );
    expect(store.listRequests().stats.bridgeDroppedEvents).toBe(2);

    expect(
      store.ingestBridgeBatch({
        ...batch(2, []),
        droppedEvents: 1,
        droppedEventsByRequest: [{ requestId: "req-1", droppedEvents: 2 }],
      }),
    ).toBe(false);
  });

  it("links browser navigation lifecycles to authoritative request IDs", () => {
    const store = createStore();
    const requestId = "req-00000000-0000-4000-8000-000000000003";
    store.ingestBridgeBatch(
      batch(1, [
        event(1, "request.started", { method: "GET" }, requestId),
        event(
          2,
          "request.completed",
          { status: 200, durationMs: 4 },
          requestId,
        ),
      ]),
    );

    expect(
      store.ingestBrowserNavigationEvent(navigationEvent(1, "started"), 1_000),
    ).toBe(true);
    expect(
      store.ingestBrowserNavigationEvent(
        navigationEvent(2, "request-linked", requestId),
        1_001,
      ),
    ).toBe(true);
    expect(
      store.ingestBrowserNavigationEvent(navigationEvent(2, "started"), 1_002),
    ).toBe(true);
    expect(
      store.ingestBrowserNavigationEvent(
        navigationEvent(3, "committed"),
        1_003,
      ),
    ).toBe(true);

    expect(store.listNavigations()).toMatchObject({
      navigations: [
        {
          navigationId: "nav-00000000-0000-4000-8000-000000000002",
          completed: true,
          requestIds: [requestId],
          eventCount: 3,
        },
      ],
    });
    expect(
      store.getNavigationTrace({
        navigationId: "nav-00000000-0000-4000-8000-000000000002",
      }),
    ).toMatchObject({
      requestIds: [requestId],
      completed: true,
      events: [
        { phase: "started" },
        { phase: "request-linked", requestId },
        { phase: "committed" },
      ],
    });
    expect(
      store.listRequests({
        navigationId: "nav-00000000-0000-4000-8000-000000000002",
      }).requests[0],
    ).toMatchObject({
      requestId,
      navigationIds: ["nav-00000000-0000-4000-8000-000000000002"],
    });
  });

  it("keeps one terminal phase while accepting late request links", () => {
    const store = createStore();
    const requestId = "req-00000000-0000-4000-8000-000000000003";
    expect(
      store.ingestBrowserNavigationEvent(navigationEvent(1, "committed")),
    ).toBe(false);
    expect(
      store.ingestBrowserNavigationEvent(navigationEvent(1, "started")),
    ).toBe(true);
    expect(
      store.ingestBrowserNavigationEvent(navigationEvent(2, "committed")),
    ).toBe(true);
    expect(
      store.ingestBrowserNavigationEvent(navigationEvent(3, "failed")),
    ).toBe(true);
    expect(
      store.ingestBrowserNavigationEvent(
        navigationEvent(4, "request-linked", requestId),
      ),
    ).toBe(true);

    expect(
      store
        .getNavigationTrace({
          navigationId: "nav-00000000-0000-4000-8000-000000000002",
        })
        .events.map((event) => event.phase),
    ).toEqual(["started", "committed", "request-linked"]);
  });

  it("evicts completed navigations before active ones and releases document sequences", () => {
    const store = createStore();
    const id = (prefix: "doc" | "nav", value: number): string =>
      `${prefix}-${value.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
    const activeDocument = id("doc", 1);
    const activeNavigation = id("nav", 1);
    store.ingestBrowserNavigationEvent(
      navigationEvent(1, "started", undefined, {
        documentId: activeDocument,
        navigationId: activeNavigation,
      }),
    );
    for (let index = 2; index <= 100; index++) {
      const documentId = id("doc", index);
      const navigationId = id("nav", index);
      store.ingestBrowserNavigationEvent(
        navigationEvent(1, "started", undefined, {
          documentId,
          navigationId,
        }),
      );
      store.ingestBrowserNavigationEvent(
        navigationEvent(2, "committed", undefined, {
          documentId,
          navigationId,
        }),
      );
    }
    const nextDocument = id("doc", 101);
    const nextNavigation = id("nav", 101);
    store.ingestBrowserNavigationEvent(
      navigationEvent(1, "started", undefined, {
        documentId: nextDocument,
        navigationId: nextNavigation,
      }),
    );

    expect(
      store.getNavigationTrace({ navigationId: activeNavigation }).completed,
    ).toBe(false);
    const recycledNavigation = id("nav", 1_002);
    expect(
      store.ingestBrowserNavigationEvent(
        navigationEvent(1, "started", undefined, {
          documentId: id("doc", 2),
          navigationId: recycledNavigation,
        }),
      ),
    ).toBe(true);
    expect(
      store.getNavigationTrace({ navigationId: recycledNavigation }),
    ).toMatchObject({ completed: false });
  });

  it("redacts structured credential fields at host ingestion", () => {
    const store = createStore();
    store.ingestBridgeBatch(
      batch(1, [
        event(1, "error.reported", {
          error: {
            name: "Error",
            message: "invalid session=visible",
            stack: "Error: jwt=visible-stack",
            token: "visible-token",
          },
          authorization: "Bearer visible-auth",
          cookie: "sid=visible-cookie",
          "set-cookie": "session=visible-set-cookie",
          "cf-access-jwt-assertion": "visible-jwt",
        }),
      ]),
    );

    const trace = JSON.stringify(store.getRequestTrace({ requestId: "req-1" }));
    const errors = JSON.stringify(store.getErrors({ requestId: "req-1" }));
    expect(trace).not.toContain("visible");
    expect(errors).not.toContain("visible");
    expect(
      store.getErrors({ requestId: "req-1" }).errors[0]?.error,
    ).toMatchObject({ name: "Error" });
  });

  it("retains a bounded multi-frame stack in error summaries", () => {
    const store = createStore();
    const stack = `Error: failed\n${Array.from(
      { length: 20 },
      (_, index) => `    at frame${index} (/project/source-${index}.ts:1:1)`,
    ).join("\n")}`;
    store.ingestBridgeBatch(
      batch(1, [
        event(1, "error.reported", {
          error: { name: "Error", message: "failed", stack },
        }),
      ]),
    );

    const error = store.getErrors({ requestId: "req-1" }).errors[0]?.error;
    expect(error).toMatchObject({ name: "Error", message: "failed" });
    expect((error as { stack: string }).stack).toContain("frame10");
    expect(
      Buffer.byteLength((error as { stack: string }).stack),
    ).toBeLessThanOrEqual(2_048);
  });

  it("bounds request links retained for one browser navigation", () => {
    const store = createStore();
    const overflowRequestId = "req-00000040-0000-4000-8000-000000000000";
    store.ingestBridgeBatch(
      batch(1, [
        event(1, "request.started", { method: "GET" }, overflowRequestId),
        event(
          2,
          "request.completed",
          { status: 200, durationMs: 1 },
          overflowRequestId,
        ),
      ]),
    );
    store.ingestBrowserNavigationEvent(navigationEvent(1, "started"));
    for (let index = 0; index < 65; index++) {
      const requestId = `req-${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
      expect(
        store.ingestBrowserNavigationEvent(
          navigationEvent(index + 2, "request-linked", requestId),
        ),
      ).toBe(true);
    }

    const trace = store.getNavigationTrace({
      navigationId: "nav-00000000-0000-4000-8000-000000000002",
    });
    expect(trace.requestIds).toHaveLength(64);
    expect(trace.events).toHaveLength(66);
    expect(trace.truncated).toBe(true);
    expect(
      store.listRequests({
        navigationId: "nav-00000000-0000-4000-8000-000000000002",
      }).requests,
    ).toHaveLength(0);
  });

  it("projects composed cache, PPR, and loader generation facts", () => {
    const store = createStore();
    const events = [
      event(1, "request.started", { method: "GET" }),
      event(2, "request.classified", {
        transport: "document",
        routePattern: "/blog/:postId",
      }),
      {
        ...event(3, "cache.scope", {
          kind: "explicit",
          ownerType: "route",
          outcome: "hit",
          source: "runtime",
          storeKind: "MemorySegmentCacheStore",
          ttl: 60,
          swr: 30,
          backgroundRevalidationClaimed: false,
        }),
        segmentId: "blog.route",
      },
      event(4, "ppr.document", {
        outcome: "hit",
        freshness: "fresh",
        source: "runtime",
        backgroundCaptureRequested: false,
      }),
      {
        ...event(5, "loader.registered", {
          loaderId: "live-loader",
          registeredBy: "blog.route",
          lane: "live",
          boundary: "loading",
          dataCache: "none",
        }),
        segmentId: "blog.live",
      },
      event(6, "loader.consumer", {
        loaderId: "live-loader",
        kind: "dsl-client",
        consumerId: null,
        lane: "live",
        boundary: "loading",
        containerValue: "request",
        nestedPromises: "request",
      }),
      event(7, "phase.completed", {
        phase: "loader",
        label: "live-loader",
        durationMs: 4,
      }),
      {
        ...event(8, "loader.registered", {
          loaderId: "baked-loader",
          registeredBy: "blog.layout",
          lane: "baked",
          boundary: "none",
          dataCache: "configured",
        }),
        segmentId: "blog.baked",
      },
      event(9, "loader.cache", {
        loaderId: "baked-loader",
        outcome: "stale",
        reason: null,
        ttl: 120,
        swr: null,
        backgroundRevalidationRequested: false,
      }),
      event(10, "loader.consumer", {
        loaderId: "baked-loader",
        kind: "dsl-client",
        consumerId: "blog.baked",
        lane: "baked",
        boundary: "consumer-suspense",
        containerValue: "capture-generation",
        nestedPromises: "request",
      }),
      event(11, "phase.completed", {
        phase: "loader",
        label: "baked-loader",
        durationMs: 12,
      }),
      {
        ...event(12, "loader.registered", {
          loaderId: "baked-loader",
          registeredBy: "blog.sidebar",
          lane: "live",
          boundary: "loading",
          dataCache: "configured",
        }),
        segmentId: "blog.sidebar.baked",
      },
      event(13, "phase.completed", {
        phase: "handler",
        label: "blog.route",
        durationMs: 2,
      }),
      event(14, "ppr.capture", {
        outcome: "stored",
        reason: "store-write-failed",
        storeWrite: "failed",
      }),
      event(15, "loader.consumer", {
        loaderId: "baked-loader",
        kind: "loader-dependency",
        consumerId: "live-loader",
        lane: "inherit",
        boundary: "inherit",
        containerValue: "request",
        nestedPromises: "request",
      }),
    ];
    expect(store.ingestBridgeBatch(batch(1, events))).toBe(true);

    const result = store.explainRender({ requestId: "req-1" });
    expect(result.renderCache).toContainEqual(
      expect.objectContaining({
        segmentId: "blog.route",
        kind: "explicit",
        outcome: "hit",
      }),
    );
    expect(result.ppr.document).toContainEqual(
      expect.objectContaining({ outcome: "hit", freshness: "fresh" }),
    );
    expect(result.ppr.capture).toContainEqual(
      expect.objectContaining({
        outcome: "captured",
        reason: "store-write-failed",
        storeWrite: "failed",
      }),
    );
    expect(result.loaders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          loaderId: "live-loader",
          registrations: [expect.objectContaining({ lane: "live" })],
          execution: { outcome: "ran", durationMs: 4 },
        }),
        expect.objectContaining({
          loaderId: "baked-loader",
          registrations: [
            expect.objectContaining({ lane: "baked" }),
            expect.objectContaining({ lane: "live" }),
          ],
          execution: { outcome: "cached", freshness: "stale" },
          consumers: expect.arrayContaining([
            expect.objectContaining({
              containerValue: "capture-generation",
              nestedPromises: "request",
            }),
            expect.objectContaining({
              kind: "loader-dependency",
              consumerId: "live-loader",
              lane: "live",
              boundary: "loading",
            }),
          ]),
        }),
      ]),
    );
    expect(result.handlers).toEqual([
      { handlerId: "blog.route", outcome: "ran", durationMs: 2 },
    ]);
  });

  it("projects exact cache-tag activity without claiming store state", () => {
    const store = createStore();
    expect(
      store.ingestBridgeBatch(
        batch(1, [
          event(1, "cache.tags", {
            kind: "observe",
            artifact: "function",
            phase: "write",
            provenance: ["static-policy", "runtime"],
            tags: ["products", "product:alpha", "password=hunter2"],
            tagDigests: ["cache-a", "cache-b", "cache-c"],
            tagCount: 3,
            tagsTruncated: false,
            identityDigest: "cache-entry",
            outcome: "catalog#getProduct",
          }),
          event(2, "cache.tags", {
            kind: "invalidate",
            verb: "updateTag",
            outcome: "completed",
            tags: ["product:alpha"],
            tagDigests: ["cache-b"],
            tagCount: 1,
            tagsTruncated: false,
            capableStoreCount: 2,
            incapableStoreCount: 0,
          }),
        ]),
      ),
    ).toBe(true);

    const result = store.explainCacheTags({ requestId: "req-1" });
    expect(result).toMatchObject({
      requestId: "req-1",
      valuesExposed: true,
      storeState: "not-inspected",
      truncated: false,
      operations: [
        {
          kind: "observe",
          artifact: "function",
          phase: "write",
          provenance: ["static-policy", "runtime"],
          tags: [
            { value: "products", digest: "cache-a" },
            { value: "product:alpha", digest: "cache-b" },
            { value: "password=[redacted]", digest: "cache-c" },
          ],
          identityDigest: "cache-entry",
        },
        {
          kind: "invalidate",
          verb: "updateTag",
          outcome: "completed",
          capableStoreCount: 2,
          incapableStoreCount: 0,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("rejects unknown transaction selectors and shrinks oversized tag projections", () => {
    const store = createStore();
    const tags = Array.from(
      { length: 16 },
      (_, index) => `${index}-${"x".repeat(300)}`,
    );
    const events = Array.from({ length: 64 }, (_, index) =>
      event(index + 1, "cache.tags", {
        kind: "observe",
        artifact: "function",
        phase: "write",
        provenance: ["runtime"],
        tags,
        tagDigests: tags.map((_, tagIndex) => `cache-${tagIndex}`),
        tagCount: tags.length,
        tagsTruncated: false,
        identityDigest: `cache-entry-${index}`,
        outcome: "catalog#getProduct",
      }),
    );
    for (let offset = 0; offset < events.length; offset += 16) {
      expect(
        store.ingestBridgeBatch(
          batch(offset / 16 + 1, events.slice(offset, offset + 16)),
        ),
      ).toBe(true);
    }

    expect(() =>
      store.explainCacheTags({
        requestId: "req-1",
        transactionId: "missing-transaction",
      }),
    ).toThrow("No retained transaction");
    const result = store.explainCacheTags({ requestId: "req-1" });
    expect(result.truncated).toBe(true);
    expect(result.operations.length).toBeLessThan(64);
    expect(serializedToolResultBytes(result)).toBeLessThanOrEqual(
      RANGO_MCP_MAX_RESULT_BYTES,
    );
    expect(result.operations[0]?.tags[0]?.value.endsWith("...")).toBe(true);
  });

  it("marks malformed tag events incomplete instead of inventing defaults", () => {
    const store = createStore();
    expect(
      store.ingestBridgeBatch(
        batch(1, [
          event(1, "cache.tags", {
            kind: "invalidate",
            verb: "updateTag",
            outcome: "completed",
          }),
        ]),
      ),
    ).toBe(true);

    expect(store.explainCacheTags({ requestId: "req-1" })).toMatchObject({
      operations: [],
      truncated: true,
    });
  });

  it("marks sanitized digest evidence as truncated", () => {
    const store = createStore();
    expect(
      store.ingestBridgeBatch(
        batch(1, [
          event(1, "cache.tags", {
            kind: "observe",
            artifact: "function",
            phase: "write",
            provenance: ["runtime"],
            tags: ["products"],
            tagDigests: ["d".repeat(1_000)],
            tagCount: 1,
            tagsTruncated: false,
          }),
        ]),
      ),
    ).toBe(true);

    const result = store.explainCacheTags({ requestId: "req-1" });
    expect(result.truncated).toBe(true);
    expect(result.operations[0]).toMatchObject({
      tagsTruncated: true,
      tags: [{ value: "products" }],
    });
  });

  it("projects revalidation independently by request or transaction", () => {
    const store = createStore();
    const revalidation = {
      ...event(1, "revalidation.trace", {
        method: "POST",
        routeKey: "blog.post",
        isAction: true,
        actionId: "save-post",
        stale: false,
        pathChanged: true,
        previousSearchNames: ["draft"],
        nextSearchNames: ["saved"],
        entries: [
          {
            segmentId: "blog.route",
            segmentType: "route",
            belongsToRoute: true,
            source: "route-handler",
            defaultShouldRevalidate: true,
            finalShouldRevalidate: false,
            reason: "custom revalidator returned false",
            customRevalidators: 1,
          },
          {
            segmentId: "blog.loader",
            segmentType: "loader",
            belongsToRoute: true,
            source: "loader",
            defaultShouldRevalidate: true,
            finalShouldRevalidate: true,
            reason: "action default",
            customRevalidators: 0,
          },
        ],
      }),
      transactionId: "action-tx",
    };
    expect(store.ingestBridgeBatch(batch(1, [revalidation]))).toBe(true);
    expect(
      store.ingestBridgeBatch(
        batch(2, [
          {
            ...event(1, "revalidation.trace", {}, "req-2"),
            transactionId: "action-tx",
          },
        ]),
      ),
    ).toBe(true);

    const byRequest = store.explainRevalidation({ requestId: "req-1" });
    const byTransaction = store.explainRevalidation({
      requestId: "req-1",
      transactionId: "action-tx",
    });
    expect(byTransaction).toEqual(byRequest);
    expect(byRequest).toMatchObject({
      actionId: "save-post",
      pathChanged: true,
      previousSearchNames: ["draft"],
      nextSearchNames: ["saved"],
      decisions: [
        expect.objectContaining({
          segmentId: "blog.route",
          kind: "segment",
          finalShouldRevalidate: false,
        }),
        expect.objectContaining({
          segmentId: "blog.loader",
          kind: "loader",
          finalShouldRevalidate: true,
        }),
      ],
    });
    expect(() =>
      store.explainRevalidation({
        requestId: "req-1",
        transactionId: "another-request-tx",
      }),
    ).toThrow("req-1/another-request-tx");
  });

  it("reports truncated revalidation search names", () => {
    const store = createStore();
    const searchNames = Array.from(
      { length: 9 },
      (_, index) => `field-${index}`,
    );
    expect(
      store.ingestBridgeBatch(
        batch(1, [
          event(1, "revalidation.trace", {
            previousSearchNames: searchNames,
            nextSearchNames: searchNames,
            entries: [],
          }),
        ]),
      ),
    ).toBe(true);

    const result = store.explainRevalidation({ requestId: "req-1" });
    expect(result.previousSearchNames).toHaveLength(8);
    expect(result.nextSearchNames).toHaveLength(8);
    expect(result.truncated).toBe(true);
  });

  it("bounds raw trace transaction IDs without mutating retained events", () => {
    const store = createStore();
    const events = Array.from({ length: 140 }, (_, index) => ({
      ...event(index + 1, "phase.completed"),
      transactionId: `tx-${index}`,
    }));
    for (let index = 0; index < 4; index++) {
      expect(
        store.ingestBridgeBatch(
          batch(index + 1, events.slice(index * 35, (index + 1) * 35)),
        ),
      ).toBe(true);
    }

    const result = store.getRequestTrace({ requestId: "req-1" });
    expect(result.trace.transactionIds).toHaveLength(128);
    expect(result.omittedTransactions).toBe(12);
    expect(result.outputTruncated).toBe(true);
    expect(result.trace.events).toHaveLength(140);
    expect(
      store.getRequestTrace({ requestId: "req-1" }).trace.events,
    ).toHaveLength(140);
  });

  it("bounds large trace projections while reporting omitted events", () => {
    const store = createStore();
    for (let batchIndex = 0; batchIndex < 2; batchIndex++) {
      const events = Array.from({ length: 40 }, (_, index) => {
        const sequence = batchIndex * 40 + index + 1;
        return event(sequence, "phase.completed", {
          value: "x".repeat(2_000),
        });
      });
      expect(store.ingestBridgeBatch(batch(batchIndex + 1, events))).toBe(true);
    }

    const result = store.getRequestTrace({ requestId: "req-1" });
    expect(result.outputTruncated).toBe(true);
    expect(result.omittedEvents).toBeGreaterThan(0);
    expect(serializedToolResultBytes(result)).toBeLessThanOrEqual(
      RANGO_MCP_MAX_RESULT_BYTES,
    );
  });

  it("bounds render explanations by count and projected field size", () => {
    const store = createStore();
    for (let batchIndex = 0; batchIndex < 2; batchIndex++) {
      const events = Array.from({ length: 40 }, (_, index) => {
        const sequence = batchIndex * 40 + index + 1;
        return {
          ...event(sequence, "cache.scope", {
            kind: "explicit",
            ownerType: "route",
            outcome: "hit",
            source: "runtime",
            storeKind: "segment-cache",
            ttl: null,
            swr: null,
            freshForMs: 1_000,
            tags: Array.from(
              { length: 16 },
              (_, tagIndex) => `tag-${tagIndex}-${"x".repeat(64)}`,
            ),
            identityDigest: `cache-${sequence}`,
            backgroundRevalidationClaimed: false,
          }),
          segmentId: `segment-${sequence}`,
        };
      });
      expect(store.ingestBridgeBatch(batch(batchIndex + 1, events))).toBe(true);
    }

    const result = store.explainRender({ requestId: "req-1" });
    expect(result.truncated).toBe(true);
    expect(serializedToolResultBytes(result)).toBeLessThanOrEqual(
      RANGO_MCP_MAX_RESULT_BYTES,
    );
  });

  it("retains current compilation errors, recent warnings, and resolves files", () => {
    const store = createStore();
    const now = Date.now();
    store.setStructuredErrorCapture(true);
    store.recordCompilationIssue({
      severity: "error",
      message: "broken token=visible",
      file: "/workspace/app/src/router.tsx?x=1",
      environment: "rsc",
      line: 10,
      column: 2,
      freshness: "current",
      timestamp: now,
    });
    store.recordCompilationIssue({
      severity: "error",
      message: "replacement compiler failure",
      file: "/workspace/app/src/router.tsx",
      environment: "rsc",
      freshness: "current",
      timestamp: now + 1,
    });
    store.recordCompilationIssue({
      severity: "warning",
      message: "warning",
      freshness: "recent",
      timestamp: now + 2,
    });

    expect(store.getCompilationIssues()).toMatchObject({
      capture: {
        structuredErrors: true,
        warnings: "recent-only",
      },
      issues: [
        expect.objectContaining({ severity: "warning", freshness: "recent" }),
        expect.objectContaining({
          severity: "error",
          message: "replacement compiler failure",
          file: "src/router.tsx",
          freshness: "current",
        }),
      ],
    });
    expect(JSON.stringify(store.getCompilationIssues())).not.toContain(
      "visible",
    );

    store.resolveCompilationFiles(["/workspace/app/src/router.tsx"], "client");
    expect(
      store.getCompilationIssues({ severity: "error" }).issues,
    ).toHaveLength(1);
    store.resolveCompilationFiles(["/workspace/app/src/router.tsx"], "rsc");
    expect(store.getCompilationIssues({ severity: "error" }).issues).toEqual(
      [],
    );
  });

  it("invalidates request cursors when mutable request summaries change", () => {
    const store = createStore();
    store.ingestBridgeBatch(
      batch(1, [
        event(1, "request.started", { method: "GET" }, "req-1"),
        event(2, "request.started", { method: "GET" }, "req-2"),
      ]),
    );
    const first = store.listRequests({ limit: 1 });
    expect(first.nextCursor).not.toBeNull();

    store.ingestBridgeBatch(
      batch(2, [event(3, "request.completed", { status: 200 }, "req-1")]),
    );
    expect(() =>
      store.listRequests({ limit: 1, cursor: first.nextCursor! }),
    ).toThrow("Diagnostic state changed");
  });

  it("preserves current errors when recent-warning capacity is exhausted", () => {
    const store = createStore();
    for (let index = 0; index < 100; index++) {
      store.recordCompilationIssue({
        severity: "error",
        message: `error ${index}`,
        file: `/workspace/app/src/error-${index}.tsx`,
        environment: "rsc",
        freshness: "current",
      });
    }
    store.recordCompilationIssue({
      severity: "warning",
      message: "recent warning",
      freshness: "recent",
    });

    const result = store.getCompilationIssues({ limit: 200 });
    expect(result.issues).toHaveLength(100);
    expect(result.issues.every((issue) => issue.freshness === "current")).toBe(
      true,
    );
    expect(result.droppedIssues).toBe(1);
  });

  it("includes pagination cursors in every result-size bound", () => {
    const store = createRangoMcpDiagnosticStore({
      instanceId: "00000000-0000-4000-8000-000000000001",
      projectRoot: "/workspace/app",
      getRouteSource: () => ({
        file: `src/${"s".repeat(50_000)}.tsx`,
        kind: "route",
        precision: "declaration-file",
      }),
    });
    let batchSequence = 0;
    let eventSequence = 0;
    store.ingestBridgeBatch(
      batch(
        ++batchSequence,
        Array.from({ length: 3 }, (_, index) =>
          event(
            ++eventSequence,
            "request.classified",
            { transport: "document", routePattern: "/large" },
            `request-${index}`,
          ),
        ),
      ),
    );
    store.ingestBridgeBatch(
      batch(
        ++batchSequence,
        Array.from({ length: 3 }, (_, index) =>
          event(
            ++eventSequence,
            "error.reported",
            { error: "e".repeat(5_000) },
            `error-${index}`,
          ),
        ),
      ),
    );
    for (let index = 0; index < 12; index++) {
      store.recordCompilationIssue({
        severity: "warning",
        message: `warning-${index}-${"w".repeat(3_500)}`,
        frame: "f".repeat(8_000),
        freshness: "recent",
      });
    }

    const requests = store.listRequests({ limit: 200 });
    const errors = store.getErrors({ limit: 200 });
    const issues = store.getCompilationIssues({ limit: 200 });
    expect(requests.truncated).toBe(true);
    expect(errors.truncated).toBe(true);
    expect(issues.truncated).toBe(true);
    for (const result of [requests, errors, issues]) {
      expect(serializedToolResultBytes(result)).toBeLessThanOrEqual(
        RANGO_MCP_MAX_RESULT_BYTES,
      );
    }
  }, 15_000);
});
