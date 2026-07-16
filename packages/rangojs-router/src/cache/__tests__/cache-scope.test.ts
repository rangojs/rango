import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResolvedSegment } from "../../types.js";
import type { SerializedSegmentData } from "../types.js";

// Mock the RSC module. The real renderToReadableStream / createFromReadableStream
// require a full React Server Components runtime which is not available in vitest.
// We replace them with simple JSON-based encode/decode so we can test the
// serialize/deserialize logic without the RSC dependency.
vi.mock("@vitejs/plugin-rsc/rsc", () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return {
    createTemporaryReferenceSet: () => new Set(),

    // Simulate RSC serialization: encode the value as JSON into a ReadableStream.
    renderToReadableStream: (value: unknown) => {
      const json = JSON.stringify(value);
      const bytes = encoder.encode(json);
      return new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },

    // Simulate RSC deserialization: decode JSON from the ReadableStream.
    // This mirrors the real behavior: it reads bytes from the stream and
    // interprets them. Feeding it the literal string "null" (4 chars) will
    // produce the JSON value `null`, which is NOT the same as returning
    // JavaScript `null` at the call-site -- but critically, the function
    // is called at all, which is the bug. For a real RSC stream the bytes
    // "null" are not a valid Flight payload and would throw or produce
    // wrong data.
    createFromReadableStream: async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      let result = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        result += decoder.decode(value, { stream: true });
      }
      result += decoder.decode(); // flush
      return JSON.parse(result);
    },
  };
});

// Import AFTER mocks are registered so vitest applies them.
const { serializeSegments, deserializeSegments, serializeResult } =
  await import("../segment-codec.js");
const { CacheScope } = await import("../cache-scope.js");
const { createRequestContext, runWithRequestContext } =
  await import("../../server/request-context.js");

import type { SegmentCacheStore, CachedEntryData } from "../types.js";
import type { PartialCacheOptions } from "../../types.js";
import { runWithRequestTransaction } from "../../router/request-identity.js";
import {
  getDevelopmentDiagnosticHub,
  resetDevelopmentDiagnosticHub,
} from "../../router/diagnostics/hub.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSegment(
  overrides: Partial<ResolvedSegment> = {},
): ResolvedSegment {
  return {
    id: "test-segment",
    namespace: "test",
    type: "route",
    index: 0,
    component: "component-placeholder",
    params: {},
    ...overrides,
  } as ResolvedSegment;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("serializeSegments / deserializeSegments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("serializeSegments - loading field encoding", () => {
    it("should encode loading: undefined as encodedLoading: undefined", async () => {
      const segments = [makeSegment({ loading: undefined })];
      const serialized = await serializeSegments(segments);

      expect(serialized).toHaveLength(1);
      expect(serialized[0].encodedLoading).toBeUndefined();
    });

    it('should encode loading: null as "null" sentinel string', async () => {
      // loading: null is stored as the literal string "null" to distinguish
      // it from undefined. Both produce the same tree shape, but the
      // reconciler compares loading values for structural preservation.
      const segments = [makeSegment({ loading: null })];
      const serialized = await serializeSegments(segments);

      expect(serialized).toHaveLength(1);
      expect(serialized[0].encodedLoading).toBe("null");
    });

    it("should encode a truthy loading value via RSC serialization", async () => {
      const loadingNode = {
        type: "div",
        props: { children: "Loading..." },
      } as ReactNode;
      const segments = [makeSegment({ loading: loadingNode })];
      const serialized = await serializeSegments(segments);

      expect(serialized).toHaveLength(1);
      // The mock RSC serializer produces a JSON string of the value.
      // The important thing is it is NOT the literal "null" sentinel.
      expect(serialized[0].encodedLoading).toBeDefined();
      expect(serialized[0].encodedLoading).not.toBe("null");
    });
  });

  describe("deserializeSegments - loading field decoding", () => {
    it("should deserialize encodedLoading: undefined as loading: undefined", async () => {
      const data: SerializedSegmentData[] = [
        {
          encoded: JSON.stringify("component-placeholder"),
          encodedLoading: undefined,
          metadata: {
            id: "seg-1",
            type: "route",
            namespace: "test",
            index: 0,
            params: {},
          },
        },
      ];

      const result = await deserializeSegments(data);

      expect(result).toHaveLength(1);
      expect(result[0].loading).toBeUndefined();
    });

    it("round-trip: loading: null should survive serialize -> deserialize as null", async () => {
      const original = [makeSegment({ loading: null })];
      const serialized = await serializeSegments(original);
      const deserialized = await deserializeSegments(serialized);

      expect(deserialized).toHaveLength(1);
      expect(deserialized[0].loading).toBe(null);
    });

    it("round-trip: loading: undefined should survive serialize -> deserialize as undefined", async () => {
      const original = [makeSegment({ loading: undefined })];
      const serialized = await serializeSegments(original);
      const deserialized = await deserializeSegments(serialized);

      expect(deserialized).toHaveLength(1);
      expect(deserialized[0].loading).toBeUndefined();
    });

    it("round-trip: truthy loading should survive serialize -> deserialize", async () => {
      const loadingNode = {
        type: "div",
        props: { children: "Loading..." },
      } as ReactNode;
      const original = [makeSegment({ loading: loadingNode })];
      const serialized = await serializeSegments(original);
      const deserialized = await deserializeSegments(serialized);

      expect(deserialized).toHaveLength(1);
      expect(deserialized[0].loading).toEqual(loadingNode);
    });
  });

  describe("metadata preservation", () => {
    it("should preserve segment metadata through round-trip", async () => {
      const original = [
        makeSegment({
          id: "L0",
          type: "layout",
          namespace: "app",
          index: 2,
          params: { slug: "hello" },
          slot: "main",
          belongsToRoute: true,
          layoutName: "root",
          loaderId: "loader-1",
          loaderIds: ["a", "b"],
        }),
      ];
      const serialized = await serializeSegments(original);
      const deserialized = await deserializeSegments(serialized);

      expect(deserialized).toHaveLength(1);
      const seg = deserialized[0];
      expect(seg.id).toBe("L0");
      expect(seg.type).toBe("layout");
      expect(seg.namespace).toBe("app");
      expect(seg.index).toBe(2);
      expect(seg.params).toEqual({ slug: "hello" });
      expect(seg.slot).toBe("main");
      expect(seg.belongsToRoute).toBe(true);
      expect(seg.layoutName).toBe("root");
      expect(seg.loaderId).toBe("loader-1");
      expect(seg.loaderIds).toEqual(["a", "b"]);
    });

    it("should round-trip component values", async () => {
      const original = [
        makeSegment({
          component: { type: "div", props: { id: "test" } } as any,
        }),
      ];
      const serialized = await serializeSegments(original);
      const deserialized = await deserializeSegments(serialized);

      expect(deserialized[0].component).toEqual({
        type: "div",
        props: { id: "test" },
      });
    });

    it("should round-trip layout values", async () => {
      const original = [
        makeSegment({ layout: { type: "nav", props: {} } as any }),
      ];
      const serialized = await serializeSegments(original);
      const deserialized = await deserializeSegments(serialized);

      expect(deserialized[0].layout).toEqual({ type: "nav", props: {} });
    });
  });

  describe("mountPath round-trip", () => {
    it("should preserve mountPath through serialize/deserialize", async () => {
      const original = [makeSegment({ mountPath: "/admin", type: "layout" })];
      const serialized = await serializeSegments(original);

      expect(serialized[0].metadata.mountPath).toBe("/admin");

      const deserialized = await deserializeSegments(serialized);
      expect(deserialized[0].mountPath).toBe("/admin");
    });

    it("should preserve undefined mountPath (non-mounted segment)", async () => {
      const original = [makeSegment({})];
      const serialized = await serializeSegments(original);
      const deserialized = await deserializeSegments(serialized);

      expect(deserialized[0].mountPath).toBeUndefined();
    });
  });

  describe("sentinel handling must bypass rscDeserialize", () => {
    it('should NOT call createFromReadableStream when encodedLoading is "null"', async () => {
      const rscModule = await import("@vitejs/plugin-rsc/rsc");
      const createSpy = vi.fn(rscModule.createFromReadableStream);

      // Temporarily replace the module's export
      const originalFn = rscModule.createFromReadableStream;
      (rscModule as any).createFromReadableStream = createSpy;

      const data: SerializedSegmentData[] = [
        {
          encoded: JSON.stringify("component-placeholder"),
          encodedLoading: "null",
          metadata: {
            id: "seg-sentinel",
            type: "route",
            namespace: "test",
            index: 0,
            params: {},
          },
        },
      ];

      const result = await deserializeSegments(data);

      // The loading value should be null (the JavaScript value), not whatever
      // the RSC decoder returns for the byte sequence "null".
      expect(result[0].loading).toBe(null);

      // createFromReadableStream should only be called once (for the component
      // stream). The "null" sentinel should be caught before rscDeserialize.
      expect(createSpy).toHaveBeenCalledTimes(1);

      // Restore
      (rscModule as any).createFromReadableStream = originalFn;
    });
  });
});

// ---------------------------------------------------------------------------
// lookupRoute records the cached entry's tags on a hit (cache-tag invalidation)
// ---------------------------------------------------------------------------

describe("CacheScope.lookupRoute - records hit tags into request tag union", () => {
  // Minimal store: only get() participates in lookupRoute. Returns a hit whose
  // CachedEntryData carries the supplied tags, mirroring MemorySegmentCacheStore
  // /CFCacheStore which return tags in data on a hit.
  async function makeHitStore(
    tags: string[] | undefined,
    diagnosticLoaderConsumers?: CachedEntryData["diagnosticLoaderConsumers"],
    diagnosticCachePolicy?: CachedEntryData["diagnosticCachePolicy"],
  ): Promise<SegmentCacheStore> {
    const segments = await serializeSegments([makeSegment()]);
    const data: CachedEntryData = {
      segments,
      handles: "",
      expiresAt: Date.now() + 60_000,
      tags,
      diagnosticLoaderConsumers,
      diagnosticCachePolicy,
    };
    return {
      get: async () => ({ data, shouldRevalidate: false }),
    } as unknown as SegmentCacheStore;
  }

  function makeCtx(store: SegmentCacheStore) {
    return createRequestContext({
      env: {},
      request: new Request("https://example.com/products"),
      url: new URL("https://example.com/products"),
      variables: {},
      cacheStore: store,
    });
  }

  function makeScope(
    store: SegmentCacheStore,
  ): InstanceType<typeof CacheScope> {
    const config: PartialCacheOptions = { ttl: 60, store };
    return new CacheScope(config);
  }

  it("records a tagged hit's tags into _requestTags", async () => {
    const store = await makeHitStore(["products"]);
    const ctx = makeCtx(store);

    const result = await runWithRequestContext(ctx, () =>
      makeScope(store).lookupRoute("/products", {}),
    );

    // The hit must succeed (segments deserialized) AND the entry's tags must now
    // be in the request tag union so document caching tags the full-page entry.
    expect(result).not.toBeNull();
    expect(result?.segments).toHaveLength(1);
    expect([...ctx._requestTags]).toEqual(["products"]);
  });

  it("leaves _requestTags empty for an untagged hit", async () => {
    const store = await makeHitStore(undefined);
    const ctx = makeCtx(store);

    const result = await runWithRequestContext(ctx, () =>
      makeScope(store).lookupRoute("/products", {}),
    );

    expect(result).not.toBeNull();
    expect(ctx._requestTags.size).toBe(0);
  });

  it("projects inherited hits through the bounded tag envelope", async () => {
    const store = await makeHitStore(["tenant-secret"], undefined, {
      ttl: 60,
      swr: 30,
    });
    const ctx = makeCtx(store);
    const scope = new CacheScope({ ttl: 60, store }, null, undefined, {
      segmentId: "catalog.layout",
      segmentType: "layout",
      inherited: true,
    });

    await runWithRequestContext(ctx, () =>
      runWithRequestTransaction(
        ctx.request,
        "request",
        () => scope.lookupRouteDetailed("/products", {}, false),
        { routerId: "shop", diagnosticsEnabled: true },
      ),
    );

    const trace = getDevelopmentDiagnosticHub()!.listTraces()[0]!;
    const scopeDiagnostic = trace.events.find(
      (event) => event.type === "cache.scope",
    )!;
    expect(scopeDiagnostic.data).toMatchObject({
      kind: "inherited",
      outcome: "hit",
      reason: null,
      ttl: 60,
      swr: 30,
      tags: [],
    });
    expect(scopeDiagnostic.data.identityDigest).toMatch(/^cache-[0-9a-f]{16}$/);
    expect(JSON.stringify(scopeDiagnostic)).not.toContain("tenant-secret");
    expect(JSON.stringify(scopeDiagnostic)).not.toContain(
      "example.com/products",
    );

    const tagDiagnostic = trace.events.find(
      (event) => event.type === "cache.tags",
    )!;
    expect(tagDiagnostic.data).toMatchObject({
      artifact: "segment",
      phase: "hit",
      provenance: ["stored"],
      tags: ["tenant-secret"],
      tagDigests: [expect.stringMatching(/^cache-[0-9a-f]{16}$/)],
    });
    expect(JSON.stringify(tagDiagnostic)).not.toContain("example.com/products");
    resetDevelopmentDiagnosticHub();
  });

  it("retains handler loader generations with cached handler segments", async () => {
    const set = vi.fn(async () => {});
    const store = {
      get: vi.fn(async () => null),
      set,
    } as unknown as SegmentCacheStore;
    const ctx = makeCtx(store);
    ctx._diagnosticLoaderConsumers = [
      {
        loaderId: "cart-loader",
        kind: "handler",
        consumerId: "catalog.route",
      },
      {
        loaderId: "prices-loader",
        kind: "loader-dependency",
        consumerId: "cart-loader",
      },
      {
        loaderId: "unrelated-loader",
        kind: "loader-dependency",
        consumerId: "other-loader",
      },
    ];

    await runWithRequestContext(ctx, () =>
      runWithRequestTransaction(
        ctx.request,
        "request",
        () =>
          new CacheScope({ ttl: 60, store }).cacheRoute("/products", {}, [
            makeSegment({ id: "catalog.route" }),
          ]),
        { routerId: "shop", diagnosticsEnabled: true },
      ),
    );
    ctx._handleStore.seal();
    await Promise.all(ctx._pendingBackgroundTasks ?? []);

    expect(set).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        diagnosticLoaderConsumers: [
          {
            loaderId: "cart-loader",
            kind: "handler",
            consumerId: "catalog.route",
          },
          {
            loaderId: "prices-loader",
            kind: "loader-dependency",
            consumerId: "cart-loader",
          },
        ],
        diagnosticCachePolicy: { ttl: 60, swr: null },
      }),
      60,
      undefined,
    );
  });

  it("bounds loader generations retained with a cache entry", async () => {
    let cached: CachedEntryData | undefined;
    const set = vi.fn(async (_key: string, data: CachedEntryData) => {
      cached = data;
    });
    const store = {
      get: vi.fn(async () => null),
      set,
    } as unknown as SegmentCacheStore;
    const ctx = makeCtx(store);
    ctx._diagnosticLoaderConsumers = Array.from(
      { length: 160 },
      (_, index) => ({
        loaderId: `loader-${index}`,
        kind: "handler" as const,
        consumerId: "catalog.route",
      }),
    );

    await runWithRequestContext(ctx, () =>
      runWithRequestTransaction(
        ctx.request,
        "request",
        () =>
          new CacheScope({ ttl: 60, store }).cacheRoute("/products", {}, [
            makeSegment({ id: "catalog.route" }),
          ]),
        { routerId: "shop", diagnosticsEnabled: true },
      ),
    );
    ctx._handleStore.seal();
    await Promise.all(ctx._pendingBackgroundTasks ?? []);

    expect(cached?.diagnosticLoaderConsumers).toHaveLength(128);
  });

  it("replays cached handler loader generations into the request trace", async () => {
    const store = await makeHitStore(undefined, [
      {
        loaderId: "cart-loader",
        kind: "handler",
        consumerId: "catalog.route",
      },
    ]);
    const ctx = makeCtx(store);

    await runWithRequestContext(ctx, () =>
      runWithRequestTransaction(
        ctx.request,
        "request",
        () => makeScope(store).lookupRoute("/products", {}),
        { routerId: "shop", diagnosticsEnabled: true },
      ),
    );

    const consumer = getDevelopmentDiagnosticHub()!
      .listTraces()[0]!
      .events.find((event) => event.type === "loader.consumer")!;
    expect(consumer.data).toMatchObject({
      loaderId: "cart-loader",
      kind: "handler",
      consumerId: "catalog.route",
      containerValue: "capture-generation",
      nestedPromises: "none",
    });
    resetDevelopmentDiagnosticHub();
  });
});

// ---------------------------------------------------------------------------
// A throwing consumer cache({ key }) must degrade lookupRoute to a cache MISS
// (return null -> render uncached) rather than crash the foreground render.
// ---------------------------------------------------------------------------

describe("CacheScope.lookupRoute - throwing key() degrades to a miss", () => {
  function makeCtx(store: SegmentCacheStore) {
    return createRequestContext({
      env: {},
      request: new Request("https://example.com/products"),
      url: new URL("https://example.com/products"),
      variables: {},
      cacheStore: store,
    });
  }

  it("returns null (not throw) when the consumer key() throws", async () => {
    const get = vi.fn();
    const store = { get } as unknown as SegmentCacheStore;
    const config: PartialCacheOptions = {
      ttl: 60,
      store,
      // A buggy/throwing key function (e.g. reads ctx state that is absent).
      key: () => {
        throw new Error("key boom");
      },
    };
    const scope = new CacheScope(config);
    const ctx = makeCtx(store);

    const result = await runWithRequestContext(ctx, () =>
      scope.lookupRoute("/products", {}),
    );

    // Degrades to a miss; the store is never consulted (key never resolved).
    expect(result).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("returns null when an async key() rejects", async () => {
    const store = { get: vi.fn() } as unknown as SegmentCacheStore;
    const config: PartialCacheOptions = {
      ttl: 60,
      store,
      key: async () => {
        throw new Error("async key boom");
      },
    };
    const scope = new CacheScope(config);
    const ctx = makeCtx(store);

    const result = await runWithRequestContext(ctx, () =>
      scope.lookupRoute("/products", {}),
    );

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// serializeResult swallows a serialization failure and returns null (so the
// caller falls through to an uncached render) rather than throwing. The fix
// added a debug-gated log on the swallowed error; the contract under test is
// the return value and the no-throw guarantee.
// ---------------------------------------------------------------------------

describe("serializeResult - non-serializable input returns null, does not throw", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null for a value the serializer rejects", async () => {
    // The mock renderToReadableStream JSON.stringifies synchronously, so a
    // circular reference throws inside serializeResult's try.
    const circular: any = {};
    circular.self = circular;

    await expect(serializeResult(circular)).resolves.toBeNull();
  });

  it("returns null for a BigInt the serializer cannot encode", async () => {
    await expect(serializeResult(10n)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ttl/swr getters validate the resolved value and DEGRADE on garbage. An
// unvalidated NaN/Infinity ttl flows into expiry math (every `now > NaN` is
// false) so the entry never evicts; a negative ttl makes every read a miss.
// Unlike profile-registry.ts (fail fast at config time) the render path falls
// back to DEFAULT_ROUTE_TTL / undefined rather than throwing.
// ---------------------------------------------------------------------------

describe("CacheScope.ttl / swr - validation and degradation", () => {
  const DEFAULT_ROUTE_TTL = 60;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each([NaN, Infinity, -Infinity, -5])(
    "falls back to DEFAULT_ROUTE_TTL for config.ttl = %s",
    (bad) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const scope = new CacheScope({ ttl: bad });
      expect(scope.ttl).toBe(DEFAULT_ROUTE_TTL);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Invalid ttl"));
    },
  );

  it.each([0, 1, 60, 3600])("passes through a valid config.ttl = %s", (ok) => {
    const scope = new CacheScope({ ttl: ok });
    expect(scope.ttl).toBe(ok);
  });

  it.each([NaN, Infinity, -1])(
    "returns undefined for config.swr = %s",
    (bad) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const scope = new CacheScope({ ttl: 60, swr: bad });
      expect(scope.swr).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Invalid swr"));
    },
  );

  it.each([0, 5, 300])("passes through a valid config.swr = %s", (ok) => {
    const scope = new CacheScope({ ttl: 60, swr: ok });
    expect(scope.swr).toBe(ok);
  });

  it("validates an invalid store defaults.ttl when config.ttl is absent", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = {
      get: vi.fn(),
      set: vi.fn(),
      defaults: { ttl: NaN },
    } as unknown as SegmentCacheStore;
    const scope = new CacheScope({ store });
    expect(scope.ttl).toBe(DEFAULT_ROUTE_TTL);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Invalid ttl"));
  });

  it("returns undefined for an invalid store defaults.swr", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = {
      get: vi.fn(),
      set: vi.fn(),
      defaults: { ttl: 60, swr: -10 },
    } as unknown as SegmentCacheStore;
    const scope = new CacheScope({ store });
    expect(scope.swr).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Invalid swr"));
  });
});

describe("CacheScope.recordTags - first-write tags land in the request tag union synchronously", () => {
  // The miss/first-write counterpart of the hit-path test above. On a hit the
  // tags come back in the cached entry and lookupRoute records them; on a first
  // write there is no entry yet, so cache-store records the route's config tags
  // synchronously (this method) BEFORE the document cache snapshots _requestTags.
  // cacheRoute() also records them, but it runs inside requestCtx.waitUntil(),
  // racing that snapshot — recordTags() is what closes the window.
  function makeCtx() {
    return createRequestContext({
      env: {},
      request: new Request("https://example.com/products"),
      url: new URL("https://example.com/products"),
      variables: {},
    });
  }

  it("records static cache({ tags }) into _requestTags with no cache write", () => {
    const ctx = makeCtx();
    const scope = new CacheScope({ ttl: 60, tags: ["products"] });

    expect(ctx._requestTags.size).toBe(0);
    runWithRequestContext(ctx, () => scope.recordTags(ctx));

    // Tags are in the union synchronously — no cacheRoute()/waitUntil needed — so
    // the document cache's tag snapshot catches them on the very first request.
    expect([...ctx._requestTags]).toEqual(["products"]);
  });

  it("resolves dynamic tags against the request context", () => {
    const ctx = makeCtx();
    const scope = new CacheScope({
      ttl: 60,
      tags: (c) => [`path:${new URL(c.request.url).pathname}`],
    });

    runWithRequestContext(ctx, () => scope.recordTags(ctx));

    expect([...ctx._requestTags]).toEqual(["path:/products"]);
  });

  it("records nothing when the scope's write condition returns false", () => {
    const ctx = makeCtx();
    const scope = new CacheScope({
      ttl: 60,
      tags: ["products"],
      condition: () => false,
    });

    runWithRequestContext(ctx, () => scope.recordTags(ctx));

    // Matches cacheRoute's gate: a disallowed write records no tags, so the
    // document is not tagged for content the segment cache will not store.
    expect(ctx._requestTags.size).toBe(0);
  });

  it("records nothing for a disabled scope or untagged config", () => {
    const disabled = makeCtx();
    runWithRequestContext(disabled, () =>
      new CacheScope(false).recordTags(disabled),
    );
    expect(disabled._requestTags.size).toBe(0);

    const untagged = makeCtx();
    runWithRequestContext(untagged, () =>
      new CacheScope({ ttl: 60 }).recordTags(untagged),
    );
    expect(untagged._requestTags.size).toBe(0);
  });
});
