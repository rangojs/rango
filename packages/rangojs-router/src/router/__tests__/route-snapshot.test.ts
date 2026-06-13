import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before imports
vi.mock("../manifest.js", () => ({
  loadManifest: vi.fn(),
}));

vi.mock("../middleware.js", () => ({
  collectRouteMiddleware: vi.fn(() => []),
}));

vi.mock("../../cache/cache-scope.js", () => ({
  createCacheScope: vi.fn(() => null),
}));

import {
  resolveRoute,
  createRouteSnapshot,
  ensureFullRouteSnapshot,
  type RouteSnapshot,
} from "../route-snapshot.js";
import { loadManifest } from "../manifest.js";
import { collectRouteMiddleware } from "../middleware.js";
import { createCacheScope } from "../../cache/cache-scope.js";
import type { RouteMatchResult } from "../pattern-matching.js";

const mockLoadManifest = vi.mocked(loadManifest);
const mockCollectRouteMiddleware = vi.mocked(collectRouteMiddleware);
const mockCreateCacheScope = vi.mocked(createCacheScope);

function makeMatch(overrides?: Partial<RouteMatchResult>): RouteMatchResult {
  return {
    entry: {} as any,
    routeKey: "test",
    params: {},
    ...overrides,
  } as RouteMatchResult;
}

function makeEntry(overrides?: Record<string, any>) {
  return {
    type: "route" as const,
    shortCode: "R0",
    parent: null,
    cache: undefined,
    ...overrides,
  } as any;
}

describe("resolveRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadManifest.mockResolvedValue(makeEntry());
  });

  it("returns null when findMatch returns null", async () => {
    const result = await resolveRoute("/not-found", {
      findMatch: () => null,
    });
    expect(result).toBeNull();
  });

  it("returns redirect when match has redirectTo", async () => {
    const result = await resolveRoute("/old-path", {
      findMatch: () => makeMatch({ redirectTo: "/new-path" }),
    });
    expect(result).toEqual({
      type: "redirect",
      redirectTo: "/new-path",
    });
  });

  it("returns match snapshot for valid route", async () => {
    const matched = makeMatch({ routeKey: "home", params: { slug: "hello" } });
    const entry = makeEntry();
    mockLoadManifest.mockResolvedValue(entry);

    const result = await resolveRoute("/home/hello", {
      findMatch: () => matched,
    });

    expect(result).not.toBeNull();
    expect(result!.type).toBe("match");
    const snapshot = (result as { type: "match"; snapshot: RouteSnapshot })
      .snapshot;
    expect(snapshot.matched).toBe(matched);
    expect(snapshot.manifestEntry).toBe(entry);
    expect(snapshot.routeKey).toBe("home");
    expect(snapshot.params).toEqual({ slug: "hello" });
  });

  it("calls loadManifest with correct arguments", async () => {
    const matched = makeMatch({ routeKey: "blog" });
    mockLoadManifest.mockResolvedValue(makeEntry());

    await resolveRoute("/blog", {
      findMatch: () => matched,
      isSSR: true,
    });

    expect(mockLoadManifest).toHaveBeenCalledWith(
      matched.entry,
      "blog",
      "/blog",
      undefined, // metricsStore
      true, // isSSR
    );
  });

  it("passes metricsStore to loadManifest", async () => {
    const metricsStore = { metrics: [], requestStart: 0 } as any;
    mockLoadManifest.mockResolvedValue(makeEntry());

    await resolveRoute("/test", {
      findMatch: () => makeMatch(),
      metricsStore,
      isSSR: false,
    });

    expect(mockLoadManifest).toHaveBeenCalledWith(
      expect.anything(),
      "test",
      "/test",
      metricsStore,
      false,
    );
  });

  it("collects route middleware from traverseBack entries", async () => {
    const matched = makeMatch({ params: { id: "42" } });
    const entry = makeEntry();
    mockLoadManifest.mockResolvedValue(entry);
    const mw = [{ handler: vi.fn(), params: { id: "42" } }];
    mockCollectRouteMiddleware.mockReturnValue(mw);

    const result = await resolveRoute("/test", {
      findMatch: () => matched,
    });

    expect(mockCollectRouteMiddleware).toHaveBeenCalled();
    const snapshot = (result as { type: "match"; snapshot: RouteSnapshot })
      .snapshot;
    expect(snapshot.routeMiddleware).toBe(mw);
  });

  it("detects passthrough routes", async () => {
    mockLoadManifest.mockResolvedValue(
      makeEntry({ type: "route", isPassthrough: true }),
    );

    const result = await resolveRoute("/api/data", {
      findMatch: () => makeMatch(),
    });

    const snapshot = (result as { type: "match"; snapshot: RouteSnapshot })
      .snapshot;
    expect(snapshot.isPassthrough).toBe(true);
  });

  it("does not mark non-passthrough routes", async () => {
    mockLoadManifest.mockResolvedValue(makeEntry({ type: "route" }));

    const result = await resolveRoute("/page", {
      findMatch: () => makeMatch(),
    });

    const snapshot = (result as { type: "match"; snapshot: RouteSnapshot })
      .snapshot;
    expect(snapshot.isPassthrough).toBe(false);
  });

  it("does not mark layout entries as passthrough", async () => {
    mockLoadManifest.mockResolvedValue(
      makeEntry({ type: "layout", isPassthrough: true }),
    );

    const result = await resolveRoute("/page", {
      findMatch: () => makeMatch(),
    });

    const snapshot = (result as { type: "match"; snapshot: RouteSnapshot })
      .snapshot;
    expect(snapshot.isPassthrough).toBe(false);
  });

  it("builds cache scope chain from entries", async () => {
    const parentEntry = makeEntry({
      type: "layout",
      shortCode: "L0",
      parent: null,
      cache: { options: { ttl: 60 } },
    });
    const childEntry = makeEntry({
      type: "route",
      shortCode: "R0",
      parent: parentEntry,
      cache: { options: { ttl: 30 } },
    });
    mockLoadManifest.mockResolvedValue(childEntry);

    const mockScope = { enabled: true } as any;
    mockCreateCacheScope
      .mockReturnValueOnce(mockScope) // child entry
      .mockReturnValueOnce(mockScope); // parent entry

    await resolveRoute("/cached", {
      findMatch: () => makeMatch(),
    });

    expect(mockCreateCacheScope).toHaveBeenCalled();
  });

  it("extracts responseType from matched", async () => {
    mockLoadManifest.mockResolvedValue(makeEntry());

    const result = await resolveRoute("/api", {
      findMatch: () => makeMatch({ responseType: "application/json" }),
    });

    const snapshot = (result as { type: "match"; snapshot: RouteSnapshot })
      .snapshot;
    expect(snapshot.responseType).toBe("application/json");
  });

  it("extracts responseType from manifest entry when not on matched", async () => {
    mockLoadManifest.mockResolvedValue(
      makeEntry({ type: "route", responseType: "text/plain" }),
    );

    const result = await resolveRoute("/file", {
      findMatch: () => makeMatch(),
    });

    const snapshot = (result as { type: "match"; snapshot: RouteSnapshot })
      .snapshot;
    expect(snapshot.responseType).toBe("text/plain");
  });

  it("prefers matched.responseType over manifest entry", async () => {
    mockLoadManifest.mockResolvedValue(
      makeEntry({ type: "route", responseType: "text/plain" }),
    );

    const result = await resolveRoute("/api", {
      findMatch: () => makeMatch({ responseType: "application/json" }),
    });

    const snapshot = (result as { type: "match"; snapshot: RouteSnapshot })
      .snapshot;
    expect(snapshot.responseType).toBe("application/json");
  });

  it("extracts localRouteName from dotted routeKey", async () => {
    mockLoadManifest.mockResolvedValue(makeEntry());

    const result = await resolveRoute("/blog/post", {
      findMatch: () => makeMatch({ routeKey: "blog.detail" }),
    });

    const snapshot = (result as { type: "match"; snapshot: RouteSnapshot })
      .snapshot;
    expect(snapshot.localRouteName).toBe("detail");
  });

  it("uses full routeKey as localRouteName when not dotted", async () => {
    mockLoadManifest.mockResolvedValue(makeEntry());

    const result = await resolveRoute("/home", {
      findMatch: () => makeMatch({ routeKey: "home" }),
    });

    const snapshot = (result as { type: "match"; snapshot: RouteSnapshot })
      .snapshot;
    expect(snapshot.localRouteName).toBe("home");
  });

  it("pushes route-matching metric when metricsStore provided", async () => {
    const metricsStore = {
      enabled: true,
      metrics: [] as any[],
      requestStart: 100,
    };
    mockLoadManifest.mockResolvedValue(makeEntry());

    await resolveRoute("/test", {
      findMatch: () => makeMatch(),
      metricsStore,
    });

    expect(
      metricsStore.metrics.some((m: any) => m.label === "route-matching"),
    ).toBe(true);
  });

  it("pushes manifest-loading metric when metricsStore provided", async () => {
    const metricsStore = {
      enabled: true,
      metrics: [] as any[],
      requestStart: 100,
    };
    mockLoadManifest.mockResolvedValue(makeEntry());

    await resolveRoute("/test", {
      findMatch: () => makeMatch(),
      metricsStore,
    });

    expect(
      metricsStore.metrics.some((m: any) => m.label === "manifest-loading"),
    ).toBe(true);
  });

  it("does not push metrics when metricsStore is undefined", async () => {
    mockLoadManifest.mockResolvedValue(makeEntry());

    // Just verifying no crash — no metricsStore to check
    const result = await resolveRoute("/test", {
      findMatch: () => makeMatch(),
    });

    expect(result).not.toBeNull();
  });

  it("lite mode skips entries and cacheScope", async () => {
    const entry = makeEntry({ cache: { options: { ttl: 60 } } });
    mockLoadManifest.mockResolvedValue(entry);

    const result = await resolveRoute("/test", {
      findMatch: () => makeMatch(),
      lite: true,
    });

    const snapshot = (result as { type: "match"; snapshot: RouteSnapshot })
      .snapshot;
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.cacheScope).toBeNull();
    // Still computes the cheap fields
    expect(snapshot.routeMiddleware).toBeDefined();
    expect(snapshot.routeKey).toBe("test");
    expect(snapshot.responseType).toBeUndefined();
    expect(mockCreateCacheScope).not.toHaveBeenCalled();
  });

  it("skipRouteMatchMetric suppresses route-matching metric", async () => {
    const metricsStore = {
      enabled: true,
      metrics: [] as any[],
      requestStart: 100,
    };
    mockLoadManifest.mockResolvedValue(makeEntry());

    await resolveRoute("/test", {
      findMatch: () => makeMatch(),
      metricsStore,
      skipRouteMatchMetric: true,
    });

    expect(
      metricsStore.metrics.some((m: any) => m.label === "route-matching"),
    ).toBe(false);
    // manifest-loading is still pushed
    expect(
      metricsStore.metrics.some((m: any) => m.label === "manifest-loading"),
    ).toBe(true);
  });
});

describe("createRouteSnapshot", () => {
  it("creates snapshot with default values", () => {
    const snapshot = createRouteSnapshot();
    expect(snapshot.routeKey).toBe("test");
    expect(snapshot.params).toEqual({});
    expect(snapshot.routeMiddleware).toEqual([]);
    expect(snapshot.cacheScope).toBeNull();
    expect(snapshot.isPassthrough).toBe(false);
  });

  it("merges overrides", () => {
    const snapshot = createRouteSnapshot({
      routeKey: "blog",
      params: { slug: "hello" },
      isPassthrough: true,
    });
    expect(snapshot.routeKey).toBe("blog");
    expect(snapshot.params).toEqual({ slug: "hello" });
    expect(snapshot.isPassthrough).toBe(true);
  });
});

describe("ensureFullRouteSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns snapshot as-is when entries already populated", () => {
    const existing = [makeEntry()];
    const snapshot = createRouteSnapshot({ entries: existing });

    const result = ensureFullRouteSnapshot(snapshot);

    expect(result).toBe(snapshot);
    expect(result.entries).toBe(existing);
  });

  it("fills entries from manifestEntry when entries is empty", () => {
    const parentEntry = makeEntry({
      type: "layout",
      shortCode: "L0",
      parent: null,
    });
    const childEntry = makeEntry({
      type: "route",
      shortCode: "R0",
      parent: parentEntry,
    });
    const snapshot = createRouteSnapshot({
      manifestEntry: childEntry,
      entries: [],
    });

    const result = ensureFullRouteSnapshot(snapshot);

    expect(result.entries.length).toBeGreaterThan(0);
    expect(result).not.toBe(snapshot);
  });

  it("computes cacheScope from entries", () => {
    const entry = makeEntry({ cache: { options: { ttl: 60 } } });
    const snapshot = createRouteSnapshot({
      manifestEntry: entry,
      entries: [],
    });

    mockCreateCacheScope.mockReturnValue({ enabled: true } as any);

    const result = ensureFullRouteSnapshot(snapshot);

    expect(mockCreateCacheScope).toHaveBeenCalled();
  });

  it("preserves all other snapshot fields", () => {
    const mw = [{ handler: vi.fn(), params: {} }];
    const snapshot = createRouteSnapshot({
      routeKey: "blog",
      params: { slug: "hello" },
      routeMiddleware: mw,
      isPassthrough: true,
      responseType: "json",
    });

    const result = ensureFullRouteSnapshot(snapshot);

    expect(result.routeKey).toBe("blog");
    expect(result.params).toEqual({ slug: "hello" });
    expect(result.routeMiddleware).toBe(mw);
    expect(result.isPassthrough).toBe(true);
    expect(result.responseType).toBe("json");
  });
});
