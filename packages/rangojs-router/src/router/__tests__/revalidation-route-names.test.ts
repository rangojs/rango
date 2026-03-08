/**
 * Tests that evaluateRevalidation passes filtered routeName, fromRouteName,
 * and toRouteName to custom revalidation functions.
 *
 * Named routes should have their name passed through.
 * Auto-generated routes ($path_ prefix) should have undefined.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../logging.js", () => ({
  debugLog: vi.fn(),
  pushRevalidationTraceEntry: vi.fn(),
  isTraceActive: () => false,
}));

// Control _prevRouteKey via a mutable ref
const prevRouteKeyRef: { value: string | undefined } = { value: undefined };

vi.mock("../../server/request-context.js", () => ({
  _getRequestContext: () => ({
    _prevRouteKey: prevRouteKeyRef.value,
  }),
}));

import { evaluateRevalidation } from "../revalidation.js";

function makeSegment(overrides?: Partial<any>): any {
  return {
    id: "seg-1",
    type: "route",
    params: {},
    belongsToRoute: true,
    ...overrides,
  };
}

function makeContext(): any {
  return {
    request: new Request("http://localhost/test"),
    env: {},
    params: {},
    pathname: "/test",
    url: new URL("http://localhost/test"),
    var: {},
    get: vi.fn(),
    set: vi.fn(),
    header: vi.fn(),
    use: vi.fn(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RevalidateSpy = (args: any) => boolean;

describe("evaluateRevalidation route name filtering", () => {
  it("should pass named toRouteName and fromRouteName", async () => {
    prevRouteKeyRef.value = "blog.index";
    const spy = vi.fn<RevalidateSpy>(() => true);

    await evaluateRevalidation({
      segment: makeSegment(),
      prevParams: {},
      getPrevSegment: null,
      request: new Request("http://localhost/blog/post-1"),
      prevUrl: new URL("http://localhost/blog"),
      nextUrl: new URL("http://localhost/blog/post-1"),
      revalidations: [{ name: "test", fn: spy }],
      routeKey: "blog.post",
      context: makeContext(),
    });

    expect(spy).toHaveBeenCalledOnce();
    const args = spy.mock.calls[0][0];
    expect(args.routeName).toBe("blog.post");
    expect(args.toRouteName).toBe("blog.post");
    expect(args.fromRouteName).toBe("blog.index");
  });

  it("should set toRouteName to undefined for auto-generated route", async () => {
    prevRouteKeyRef.value = "blog.index";
    const spy = vi.fn<RevalidateSpy>(() => true);

    await evaluateRevalidation({
      segment: makeSegment(),
      prevParams: {},
      getPrevSegment: null,
      request: new Request("http://localhost/health"),
      prevUrl: new URL("http://localhost/blog"),
      nextUrl: new URL("http://localhost/health"),
      revalidations: [{ name: "test", fn: spy }],
      routeKey: "$path__health",
      context: makeContext(),
    });

    const args = spy.mock.calls[0][0];
    expect(args.routeName).toBeUndefined();
    expect(args.toRouteName).toBeUndefined();
    expect(args.fromRouteName).toBe("blog.index");
  });

  it("should set fromRouteName to undefined for auto-generated prev route", async () => {
    prevRouteKeyRef.value = "$path__health";
    const spy = vi.fn<RevalidateSpy>(() => true);

    await evaluateRevalidation({
      segment: makeSegment(),
      prevParams: {},
      getPrevSegment: null,
      request: new Request("http://localhost/blog"),
      prevUrl: new URL("http://localhost/health"),
      nextUrl: new URL("http://localhost/blog"),
      revalidations: [{ name: "test", fn: spy }],
      routeKey: "blog.index",
      context: makeContext(),
    });

    const args = spy.mock.calls[0][0];
    expect(args.routeName).toBe("blog.index");
    expect(args.toRouteName).toBe("blog.index");
    expect(args.fromRouteName).toBeUndefined();
  });

  it("should set both to undefined when both routes are unnamed", async () => {
    prevRouteKeyRef.value = "$path__health";
    const spy = vi.fn<RevalidateSpy>(() => true);

    await evaluateRevalidation({
      segment: makeSegment(),
      prevParams: {},
      getPrevSegment: null,
      request: new Request("http://localhost/status"),
      prevUrl: new URL("http://localhost/health"),
      nextUrl: new URL("http://localhost/status"),
      revalidations: [{ name: "test", fn: spy }],
      routeKey: "$path__status",
      context: makeContext(),
    });

    const args = spy.mock.calls[0][0];
    expect(args.routeName).toBeUndefined();
    expect(args.toRouteName).toBeUndefined();
    expect(args.fromRouteName).toBeUndefined();
  });

  it("should set fromRouteName to undefined when no prev route key exists", async () => {
    prevRouteKeyRef.value = undefined;
    const spy = vi.fn<RevalidateSpy>(() => true);

    await evaluateRevalidation({
      segment: makeSegment(),
      prevParams: {},
      getPrevSegment: null,
      request: new Request("http://localhost/blog"),
      prevUrl: new URL("http://localhost/"),
      nextUrl: new URL("http://localhost/blog"),
      revalidations: [{ name: "test", fn: spy }],
      routeKey: "blog.index",
      context: makeContext(),
    });

    const args = spy.mock.calls[0][0];
    expect(args.toRouteName).toBe("blog.index");
    expect(args.fromRouteName).toBeUndefined();
  });

  it("should filter namespaced auto-generated routes (e.g. docs.$path__faq)", async () => {
    prevRouteKeyRef.value = "docs.$path__faq";
    const spy = vi.fn<RevalidateSpy>(() => true);

    await evaluateRevalidation({
      segment: makeSegment(),
      prevParams: {},
      getPrevSegment: null,
      request: new Request("http://localhost/docs/guide"),
      prevUrl: new URL("http://localhost/docs/faq"),
      nextUrl: new URL("http://localhost/docs/guide"),
      revalidations: [{ name: "test", fn: spy }],
      routeKey: "docs.guide",
      context: makeContext(),
    });

    const args = spy.mock.calls[0][0];
    expect(args.toRouteName).toBe("docs.guide");
    expect(args.fromRouteName).toBeUndefined();
  });
});
