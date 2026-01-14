import { describe, it, expect } from "vitest";
import {
  buildResolutionContext,
  getRevalidationParams,
  getInterceptParams,
} from "../resolution-context";
import type { RouteMatch } from "../types";

describe("buildResolutionContext", () => {
  const createMockParams = (overrides = {}) => ({
    request: new Request("http://localhost/test"),
    url: new URL("http://localhost/test"),
    prevUrl: new URL("http://localhost/prev"),
    previousUrlRaw: "/prev",
    interceptSourceUrl: null,
    stale: false,
    matched: {
      entry: {},
      routeKey: "shop.product",
      params: { id: "123" },
    } as RouteMatch,
    prevMatch: null,
    interceptContextMatch: null,
    manifestEntry: { shortCode: "M1L0C0" } as any,
    entries: [],
    clientSegmentIds: ["M1L0C0", "M1L0C0L0"],
    prevParams: {},
    bindings: {},
    handlerContext: {} as any,
    loaderPromises: new Map(),
    metricsStore: null,
    ...overrides,
  });

  describe("basic context building", () => {
    it("should build context with all required fields", () => {
      const params = createMockParams();
      const ctx = buildResolutionContext(params);

      expect(ctx.request).toBe(params.request);
      expect(ctx.url).toBe(params.url);
      expect(ctx.prevUrl).toBe(params.prevUrl);
      expect(ctx.matched).toBe(params.matched);
      expect(ctx.entries).toBe(params.entries);
    });

    it("should compute pathname from URL", () => {
      const params = createMockParams({
        url: new URL("http://localhost/shop/products"),
      });
      const ctx = buildResolutionContext(params);

      expect(ctx.pathname).toBe("/shop/products");
    });

    it("should create clientSegmentSet from clientSegmentIds", () => {
      const params = createMockParams({
        clientSegmentIds: ["M1L0C0", "M1L0C0L0", "M1L0C0L0R0"],
      });
      const ctx = buildResolutionContext(params);

      expect(ctx.clientSegmentSet).toBeInstanceOf(Set);
      expect(ctx.clientSegmentSet.has("M1L0C0")).toBe(true);
      expect(ctx.clientSegmentSet.has("M1L0C0L0")).toBe(true);
      expect(ctx.clientSegmentSet.has("M1L0C0L0R0")).toBe(true);
      expect(ctx.clientSegmentSet.size).toBe(3);
    });
  });

  describe("computed values", () => {
    it("should compute isAction as true when actionContext provided", () => {
      const params = createMockParams({
        actionContext: { actionId: "test-action" },
      });
      const ctx = buildResolutionContext(params);

      expect(ctx.isAction).toBe(true);
    });

    it("should compute isAction as false when no actionContext", () => {
      const params = createMockParams();
      const ctx = buildResolutionContext(params);

      expect(ctx.isAction).toBe(false);
    });

    it("should extract localRouteName from routeKey with dots", () => {
      const params = createMockParams({
        matched: { entry: {}, routeKey: "shop.category.product", params: {} },
      });
      const ctx = buildResolutionContext(params);

      expect(ctx.localRouteName).toBe("product");
    });

    it("should use full routeKey as localRouteName when no dots", () => {
      const params = createMockParams({
        matched: { entry: {}, routeKey: "index", params: {} },
      });
      const ctx = buildResolutionContext(params);

      expect(ctx.localRouteName).toBe("index");
    });

    it("should compute isSameRouteNavigation when interceptContextMatch matches", () => {
      const matched = { entry: {}, routeKey: "product", params: {} };
      const params = createMockParams({
        matched,
        interceptContextMatch: matched,
      });
      const ctx = buildResolutionContext(params);

      expect(ctx.isSameRouteNavigation).toBe(true);
    });

    it("should compute isSameRouteNavigation as false when no interceptContextMatch", () => {
      const params = createMockParams({
        interceptContextMatch: null,
      });
      const ctx = buildResolutionContext(params);

      expect(ctx.isSameRouteNavigation).toBe(false);
    });

    it("should compute isSameRouteNavigation as false when routes differ", () => {
      const params = createMockParams({
        matched: { entry: {}, routeKey: "product", params: {} },
        interceptContextMatch: { entry: {}, routeKey: "shop", params: {} },
      });
      const ctx = buildResolutionContext(params);

      expect(ctx.isSameRouteNavigation).toBe(false);
    });
  });
});

describe("getRevalidationParams", () => {
  it("should extract revalidation params from context", () => {
    const ctx = buildResolutionContext({
      request: new Request("http://localhost/test"),
      url: new URL("http://localhost/test"),
      prevUrl: new URL("http://localhost/prev"),
      previousUrlRaw: "/prev",
      interceptSourceUrl: null,
      stale: false,
      matched: { entry: {}, routeKey: "test", params: { id: "1" } },
      prevMatch: null,
      interceptContextMatch: null,
      manifestEntry: {} as any,
      entries: [],
      clientSegmentIds: [],
      prevParams: { id: "0" },
      bindings: {},
      handlerContext: { test: true } as any,
      actionContext: { actionId: "action" },
      loaderPromises: new Map(),
      metricsStore: null,
    });

    const params = getRevalidationParams(ctx);

    expect(params.prevParams).toEqual({ id: "0" });
    expect(params.request).toBe(ctx.request);
    expect(params.prevUrl).toBe(ctx.prevUrl);
    expect(params.nextUrl).toBe(ctx.url);
    expect(params.routeKey).toBe("test");
    expect(params.handlerContext).toBe(ctx.handlerContext);
    expect(params.actionContext).toBe(ctx.actionContext);
  });
});

describe("getInterceptParams", () => {
  it("should extract intercept params from context", () => {
    const ctx = buildResolutionContext({
      request: new Request("http://localhost/test"),
      url: new URL("http://localhost/test"),
      prevUrl: new URL("http://localhost/prev"),
      previousUrlRaw: "/prev",
      interceptSourceUrl: null,
      stale: true,
      matched: { entry: {}, routeKey: "test", params: {} },
      prevMatch: null,
      interceptContextMatch: null,
      manifestEntry: {} as any,
      entries: [],
      clientSegmentIds: ["M1", "M2"],
      prevParams: { page: "1" },
      bindings: {},
      handlerContext: {} as any,
      actionContext: { actionId: "action" },
      loaderPromises: new Map(),
      metricsStore: null,
    });

    const params = getInterceptParams(ctx);

    expect(params.clientSegmentIds).toBe(ctx.clientSegmentSet);
    expect(params.prevParams).toEqual({ page: "1" });
    expect(params.stale).toBe(true);
    expect(params.routeKey).toBe("test");
  });
});
