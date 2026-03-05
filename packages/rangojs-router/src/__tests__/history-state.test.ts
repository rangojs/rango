import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let historyState: any = null;
const replaceStateSpy = vi.fn();
const dispatchEventSpy = vi.fn();

beforeEach(() => {
  historyState = { existing: "value" };

  replaceStateSpy.mockImplementation((state: any) => {
    historyState = state;
  });

  (globalThis as any).window = {
    history: {
      get state() {
        return historyState;
      },
      replaceState: replaceStateSpy,
    },
    location: { href: "http://localhost/page", origin: "http://localhost" },
    dispatchEvent: dispatchEventSpy,
  };
});

afterEach(() => {
  delete (globalThis as any).window;
  replaceStateSpy.mockReset();
  dispatchEventSpy.mockReset();
  vi.restoreAllMocks();
});

let buildHistoryState: typeof import("../browser/history-state").buildHistoryState;
let mergeLocationState: typeof import("../browser/history-state").mergeLocationState;
let resolveNavigationState: typeof import("../browser/history-state").resolveNavigationState;

beforeEach(async () => {
  const mod = await import("../browser/history-state");
  buildHistoryState = mod.buildHistoryState;
  mergeLocationState = mod.mergeLocationState;
  resolveNavigationState = mod.resolveNavigationState;
});

describe("buildHistoryState", () => {
  it("returns null when no state is provided", () => {
    expect(buildHistoryState(undefined)).toBeNull();
  });

  it("wraps plain state in .state property", () => {
    expect(buildHistoryState({ from: "list" })).toEqual({
      state: { from: "list" },
    });
  });

  it("spreads typed location state (keys starting with __rsc_ls_)", () => {
    const typed = { __rsc_ls_product: { name: "Widget" } };
    expect(buildHistoryState(typed)).toEqual({
      __rsc_ls_product: { name: "Widget" },
    });
  });

  it("includes intercept router state", () => {
    expect(
      buildHistoryState(undefined, {
        intercept: true,
        sourceUrl: "/products",
      }),
    ).toEqual({
      intercept: true,
      sourceUrl: "/products",
    });
  });

  it("merges user state, router state, and server state", () => {
    const result = buildHistoryState(
      { from: "list" },
      { intercept: true, sourceUrl: "/src" },
      { __rsc_ls_server: "data" },
    );
    expect(result).toEqual({
      intercept: true,
      sourceUrl: "/src",
      state: { from: "list" },
      __rsc_ls_server: "data",
    });
  });

  it("includes server state without user state", () => {
    expect(buildHistoryState(undefined, undefined, { token: "abc" })).toEqual({
      token: "abc",
    });
  });
});

describe("mergeLocationState", () => {
  it("merges state into existing history.state and replaces", () => {
    mergeLocationState({ newKey: "newValue" });

    expect(replaceStateSpy).toHaveBeenCalledOnce();
    const merged = replaceStateSpy.mock.calls[0][0];
    expect(merged).toEqual({ existing: "value", newKey: "newValue" });
  });

  it("dispatches __rsc_locationstate event when keys start with __rsc_ls_", () => {
    mergeLocationState({ __rsc_ls_flash: "message" });

    expect(dispatchEventSpy).toHaveBeenCalledOnce();
    const event = dispatchEventSpy.mock.calls[0][0];
    expect(event.type).toBe("__rsc_locationstate");
  });

  it("does not dispatch event when no __rsc_ls_ keys", () => {
    mergeLocationState({ plain: "data" });

    expect(dispatchEventSpy).not.toHaveBeenCalled();
  });
});

describe("resolveNavigationState", () => {
  it("passes through plain state unchanged", () => {
    const state = { from: "list" };
    expect(resolveNavigationState(state)).toBe(state);
  });

  it("passes through null/undefined unchanged", () => {
    expect(resolveNavigationState(null)).toBeNull();
    expect(resolveNavigationState(undefined)).toBeUndefined();
  });

  it("resolves LocationStateEntry[] into a flat object", () => {
    const entries = [
      { __rsc_ls_key: "__rsc_ls_product", __rsc_ls_value: { name: "Widget" } },
      { __rsc_ls_key: "__rsc_ls_cart", __rsc_ls_value: 3 },
    ];
    expect(resolveNavigationState(entries)).toEqual({
      __rsc_ls_product: { name: "Widget" },
      __rsc_ls_cart: 3,
    });
  });

  it("resolves lazy LocationStateEntry values", () => {
    const entries = [
      {
        __rsc_ls_key: "__rsc_ls_time",
        __rsc_ls_value: () => "resolved",
        __rsc_ls_lazy: true,
      },
    ];
    expect(resolveNavigationState(entries)).toEqual({
      __rsc_ls_time: "resolved",
    });
  });

  it("treats empty array as plain state", () => {
    const arr: unknown[] = [];
    expect(resolveNavigationState(arr)).toBe(arr);
  });
});
