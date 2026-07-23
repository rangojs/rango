import { describe, it, expect, vi } from "vitest";

vi.mock("../segment-codec.js", () => ({
  deserializeSegments: vi.fn(async () => []),
}));

import { CacheScope, resolveShellImplicitCacheScope } from "../cache-scope.js";
import { deserializeSegments } from "../segment-codec.js";
import {
  RecordingShellStore,
  SnapshotOnlySegmentStore,
} from "../shell-snapshot.js";
import {
  runWithRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import type { CachedEntryData, SegmentCacheStore } from "../types.js";
import {
  maskNestedContainerThenables,
  type MaskReport,
} from "../../router/segment-resolution/mask-nested.js";

function makeReqCtx(extra?: Record<string, unknown>): RequestContext {
  return {
    _requestTags: new Set<string>(),
    ...extra,
  } as unknown as RequestContext;
}

function makeInnerStore(): SegmentCacheStore & {
  sets: Array<[string, CachedEntryData]>;
  gets: string[];
} {
  const sets: Array<[string, CachedEntryData]> = [];
  const gets: string[] = [];
  return {
    sets,
    gets,
    async get(key: string) {
      gets.push(key);
      return null;
    },
    async set(key: string, data: CachedEntryData) {
      sets.push([key, data]);
    },
    async delete() {
      return false;
    },
  };
}

const ENTRY: CachedEntryData = {
  segments: [],
  handles: "",
  expiresAt: Date.now() + 60_000,
};

describe("resolveShellImplicitCacheScope", () => {
  it("returns null with no marker and no scope", () => {
    runWithRequestContext(makeReqCtx(), () => {
      expect(resolveShellImplicitCacheScope(null)).toBeNull();
    });
  });

  it("substitutes an ENABLED doc-level scope when the marker is set and the route derived none", () => {
    const ctx = makeReqCtx({ _shellImplicitCache: { ttl: 123, swr: 45 } });
    runWithRequestContext(ctx, () => {
      const scope = resolveShellImplicitCacheScope(null);
      expect(scope).not.toBeNull();
      expect(scope!.enabled).toBe(true);
      expect(scope!.ttl).toBe(123);
      expect(scope!.swr).toBe(45);
    });
  });

  it("a route-derived scope always wins over the marker", () => {
    const appStore = makeInnerStore();
    const replayStore = makeInnerStore();
    const routeScope = new CacheScope({ ttl: 7 });
    const ctx = makeReqCtx({
      _cacheStore: appStore,
      _shellImplicitCache: { ttl: 123, store: replayStore },
    });
    runWithRequestContext(ctx, () => {
      expect(resolveShellImplicitCacheScope(routeScope)).toBe(routeScope);
      expect(routeScope.getStore()).toBe(appStore);
    });
  });

  it("an explicit cache(false) opt-out wins over the marker (stays disabled)", () => {
    const optOut = new CacheScope(false);
    const ctx = makeReqCtx({ _shellImplicitCache: { ttl: 123 } });
    runWithRequestContext(ctx, () => {
      const scope = resolveShellImplicitCacheScope(optOut);
      expect(scope).toBe(optOut);
      expect(scope!.enabled).toBe(false);
    });
  });

  it("resolves the marker's explicit store through the scope", () => {
    const inner = makeInnerStore();
    const recording = new RecordingShellStore(inner);
    const snapshotOnly = new SnapshotOnlySegmentStore(recording);
    const ctx = makeReqCtx({
      _shellImplicitCache: { ttl: 60, store: snapshotOnly },
    });
    runWithRequestContext(ctx, () => {
      const scope = resolveShellImplicitCacheScope(null);
      expect(scope!.getStore()).toBe(snapshotOnly);
    });
  });

  it("uses the canonical document key during a partial navigation replay", async () => {
    const inner = makeInnerStore();
    const request = new Request(
      "http://localhost/p?_rsc_partial=true&_rsc_segments=L0",
    );
    const ctx = makeReqCtx({
      request,
      originalUrl: new URL(request.url),
      url: new URL("http://localhost/p"),
      _cacheStore: inner,
      _shellImplicitCache: {
        ttl: 60,
        store: inner,
        keyPrefix: "doc",
      },
    });

    await runWithRequestContext(ctx, async () => {
      const scope = resolveShellImplicitCacheScope(null)!;
      await expect(scope.lookupRoute("/p", {})).resolves.toBeNull();
    });

    expect(inner.gets).toEqual(["doc:localhost/p"]);
  });

  it("reports a replay hit only after the implicit entry decodes successfully", async () => {
    const onHit = vi.fn();
    const store: SegmentCacheStore = {
      async get() {
        return { data: ENTRY, shouldRevalidate: false };
      },
      async set() {},
      async delete() {
        return false;
      },
    };
    const ctx = makeReqCtx({
      url: new URL("http://localhost/p"),
      originalUrl: new URL("http://localhost/p?_rsc_partial=true"),
      _shellImplicitCache: {
        ttl: 60,
        store,
        keyPrefix: "doc",
        onHit,
      },
    });

    await runWithRequestContext(ctx, async () => {
      const scope = resolveShellImplicitCacheScope(null)!;
      await expect(scope.lookupRoute("/p", {})).resolves.toEqual({
        segments: [],
        shouldRevalidate: false,
      });
    });

    expect(onHit).toHaveBeenCalledTimes(1);
  });

  it("does not report PPR replay when a route-derived cache scope wins", async () => {
    const onHit = vi.fn();
    const appStore = makeInnerStore();
    const routeScope = new CacheScope({ ttl: 7 });
    const ctx = makeReqCtx({
      url: new URL("http://localhost/p"),
      originalUrl: new URL("http://localhost/p?_rsc_partial=true"),
      _cacheStore: appStore,
      _shellImplicitCache: { ttl: 60, onHit },
    });

    await runWithRequestContext(ctx, async () => {
      const scope = resolveShellImplicitCacheScope(routeScope)!;
      expect(scope).toBe(routeScope);
      await expect(scope.lookupRoute("/p", {})).resolves.toBeNull();
    });

    expect(onHit).not.toHaveBeenCalled();
  });

  it("does not report PPR replay when the seeded segment fails to decode", async () => {
    const onHit = vi.fn();
    const store: SegmentCacheStore = {
      async get() {
        return { data: ENTRY, shouldRevalidate: false };
      },
      async set() {},
      async delete() {
        return true;
      },
    };
    vi.mocked(deserializeSegments).mockRejectedValueOnce(new Error("corrupt"));
    const ctx = makeReqCtx({
      url: new URL("http://localhost/p"),
      originalUrl: new URL("http://localhost/p?_rsc_partial=true"),
      _shellImplicitCache: {
        ttl: 60,
        store,
        keyPrefix: "doc",
        onHit,
      },
    });

    await runWithRequestContext(ctx, async () => {
      const scope = resolveShellImplicitCacheScope(null)!;
      await expect(scope.lookupRoute("/p", {})).resolves.toBeNull();
    });

    expect(onHit).not.toHaveBeenCalled();
  });
});

describe("SnapshotOnlySegmentStore", () => {
  it("records segment writes into the snapshot WITHOUT writing the inner store", async () => {
    const inner = makeInnerStore();
    const recording = new RecordingShellStore(inner);
    const snapshotOnly = new SnapshotOnlySegmentStore(recording);

    await snapshotOnly.set("doc:host/exec", ENTRY);

    expect(inner.sets).toHaveLength(0);
    const snapshot = recording.drainSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot![0]).toMatchObject({
      family: "segment",
      key: "doc:host/exec",
    });
  });

  it("reads pass through the recording store to the inner store", async () => {
    const inner = makeInnerStore();
    const recording = new RecordingShellStore(inner);
    const snapshotOnly = new SnapshotOnlySegmentStore(recording);

    expect(await snapshotOnly.get("doc:host/exec")).toBeNull();
    expect(inner.gets).toEqual(["doc:host/exec"]);
  });
});

describe("maskNestedContainerThenables MaskReport (single-walk liveness signal)", () => {
  function maskReport(value: unknown): boolean {
    const report: MaskReport = { thenable: false };
    maskNestedContainerThenables(value, undefined, report);
    return report.thenable;
  }

  it("reports thenables at any depth in plain containers", () => {
    expect(maskReport({ a: Promise.resolve(1) })).toBe(true);
    expect(maskReport([{ b: [Promise.resolve(1)] }])).toBe(true);
    expect(maskReport(Promise.resolve(1))).toBe(true);
  });

  it("stays false for promise-free containers and non-plain leaves", () => {
    expect(maskReport({ a: 1, b: [true, "x", null] })).toBe(false);
    expect(maskReport(new Date())).toBe(false);
    expect(maskReport(undefined)).toBe(false);
  });

  it("is cycle-safe", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(maskReport(cyclic)).toBe(false);
    const cyclicWithPromise: Record<string, unknown> = {};
    cyclicWithPromise.self = cyclicWithPromise;
    cyclicWithPromise.p = Promise.resolve(1);
    expect(maskReport(cyclicWithPromise)).toBe(true);
  });
});
