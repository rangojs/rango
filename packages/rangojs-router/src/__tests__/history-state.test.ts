import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLocationState } from "../browser/react/location-state-shared.js";
import { withLocationStateKey } from "../testing/location-state-key.js";

let historyState: any = null;
const replaceStateSpy = vi.fn();
const pushStateSpy = vi.fn();
const dispatchEventSpy = vi.fn();

beforeEach(() => {
  historyState = { existing: "value" };

  replaceStateSpy.mockImplementation((state: any) => {
    historyState = state;
  });
  pushStateSpy.mockImplementation((state: any) => {
    historyState = state;
  });

  (globalThis as any).window = {
    history: {
      get state() {
        return historyState;
      },
      replaceState: replaceStateSpy,
      pushState: pushStateSpy,
    },
    location: { href: "http://localhost/page", origin: "http://localhost" },
    dispatchEvent: dispatchEventSpy,
  };
});

afterEach(() => {
  delete (globalThis as any).window;
  replaceStateSpy.mockReset();
  pushStateSpy.mockReset();
  dispatchEventSpy.mockReset();
  vi.restoreAllMocks();
});

let buildHistoryState: typeof import("../browser/history-state").buildHistoryState;
let mergeLocationState: typeof import("../browser/history-state").mergeLocationState;
let resolveNavigationState: typeof import("../browser/history-state").resolveNavigationState;
let pushHistoryWithIdx: typeof import("../browser/history-state").pushHistoryWithIdx;
let stripShellMissMarker: typeof import("../browser/history-state").stripShellMissMarker;
let clearLocationStateOnDocumentLoad: typeof import("../browser/history-state").clearLocationStateOnDocumentLoad;
let SHELL_MISS_MARKER: string;

beforeEach(async () => {
  const mod = await import("../browser/history-state");
  buildHistoryState = mod.buildHistoryState;
  mergeLocationState = mod.mergeLocationState;
  resolveNavigationState = mod.resolveNavigationState;
  pushHistoryWithIdx = mod.pushHistoryWithIdx;
  stripShellMissMarker = mod.stripShellMissMarker;
  clearLocationStateOnDocumentLoad = mod.clearLocationStateOnDocumentLoad;
  SHELL_MISS_MARKER = mod.SHELL_MISS_MARKER;
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

describe("stripShellMissMarker", () => {
  it("is the server's forced-MISS param", async () => {
    const { SHELL_MISS_PARAM } = await import("../rsc/shell-serve");
    expect(SHELL_MISS_MARKER).toBe(SHELL_MISS_PARAM);
  });

  it("drops the marker from the address bar, keeping the entry's state and the other params", () => {
    (globalThis as any).window.location.href =
      "http://localhost/page?probe=1&_rsc_shell=miss#top";

    stripShellMissMarker();

    expect(replaceStateSpy).toHaveBeenCalledOnce();
    expect(replaceStateSpy).toHaveBeenCalledWith(
      { existing: "value" },
      "",
      "http://localhost/page?probe=1#top",
    );
  });

  it("does nothing for a URL without the marker", () => {
    (globalThis as any).window.location.href = "http://localhost/page?a=1";

    stripShellMissMarker();
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });
});

describe("clearLocationStateOnDocumentLoad", () => {
  const Carried = withLocationStateKey(
    createLocationState<string[]>({ clearOnReload: true }),
    "Carried",
  );
  const CarriedVersioned = withLocationStateKey(
    createLocationState<string[]>({ clearOnReload: true, version: 3 }),
    "CarriedVersioned",
  );
  const Versioned = withLocationStateKey(
    createLocationState<string[]>({ version: 3 }),
    "Versioned",
  );
  const Plain = withLocationStateKey(createLocationState<string[]>(), "Plain");

  it("removes every clearOnReload slot and leaves the rest of the entry's state", () => {
    const kept = {
      [Versioned.__rsc_ls_key]: Versioned(["v"]).__rsc_ls_value,
      [Plain.__rsc_ls_key]: ["p"],
      state: { from: "list" },
      idx: 4,
      key: "scroll-key",
    };
    historyState = {
      ...kept,
      [Carried.__rsc_ls_key]: Carried(["a"]).__rsc_ls_value,
      [CarriedVersioned.__rsc_ls_key]: CarriedVersioned(["b"]).__rsc_ls_value,
    };

    clearLocationStateOnDocumentLoad();

    expect(replaceStateSpy).toHaveBeenCalledOnce();
    expect(replaceStateSpy.mock.calls[0]).toEqual([kept, ""]);
    expect(Carried.read()).toBeUndefined();
    expect(CarriedVersioned.read()).toBeUndefined();
    expect(Versioned.read()).toEqual(["v"]);
    expect(Plain.read()).toEqual(["p"]);
  });

  it("leaves history untouched when no slot is marked", () => {
    const states: unknown[] = [
      null,
      "primitive",
      { idx: 1 },
      {
        [Plain.__rsc_ls_key]: ["p"],
        [Versioned.__rsc_ls_key]: Versioned(["v"]).__rsc_ls_value,
        state: { from: "list" },
      },
      // A raw value written before the definition had the option.
      { [Carried.__rsc_ls_key]: ["legacy"] },
    ];
    for (const state of states) {
      historyState = state;
      clearLocationStateOnDocumentLoad();
      expect(historyState).toBe(state);
    }
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });

  it("only reads slots under the __rsc_ls_ prefix", () => {
    const lookalike = Carried(["a"]).__rsc_ls_value;
    historyState = { state: lookalike, other: lookalike };

    clearLocationStateOnDocumentLoad();

    expect(replaceStateSpy).not.toHaveBeenCalled();
  });
});

describe("pushHistoryWithIdx", () => {
  it("stamps idx=1 on first push from initial entry without idx", () => {
    historyState = null;
    pushHistoryWithIdx({ foo: "bar" }, "/next", false);
    expect(pushStateSpy).toHaveBeenCalledOnce();
    expect(pushStateSpy.mock.calls[0][0]).toEqual({ foo: "bar", idx: 1 });
  });

  it("increments idx on subsequent push", () => {
    historyState = { idx: 3, foo: "x" };
    pushHistoryWithIdx({ bar: "y" }, "/next", false);
    expect(pushStateSpy.mock.calls[0][0]).toEqual({ bar: "y", idx: 4 });
  });

  it("keeps idx unchanged on replace", () => {
    historyState = { idx: 5 };
    pushHistoryWithIdx({ a: 1 }, "/same", true);
    expect(replaceStateSpy).toHaveBeenCalledOnce();
    expect(replaceStateSpy.mock.calls[0][0]).toEqual({ a: 1, idx: 5 });
  });

  it("treats null state as empty object", () => {
    historyState = { idx: 2 };
    pushHistoryWithIdx(null, "/next", false);
    expect(pushStateSpy.mock.calls[0][0]).toEqual({ idx: 3 });
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

// #993: the two state mistakes HistoryState rejects at compile time, caught at
// runtime for untyped (JS) callers. Before, a bare entry was silently spread
// onto history.state (useLocationState read undefined) and an uncalled
// definition reached pushState (DataCloneError).
describe("resolveNavigationState dev checks", () => {
  const definition = (key: string) =>
    withLocationStateKey(createLocationState<{ count: number }>(), key);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws on a typed entry passed without its array", () => {
    const GridState = definition("__rsc_ls_src/state.ts#GridState");
    expect(() => resolveNavigationState(GridState({ count: 3 }))).toThrow(
      '[rango] navigation state is a single location-state entry (key "__rsc_ls_src/state.ts#GridState"). Wrap it in an array: { state: [MyState(value)] }.',
    );
  });

  it("throws on a definition passed without calling it, bare or in the array", () => {
    const GridState = definition("__rsc_ls_src/state.ts#GridState");
    const message =
      '[rango] navigation state contains a location-state definition (key "__rsc_ls_src/state.ts#GridState") instead of an entry. Call it with the value: { state: [MyState(value)] }, not [MyState].';
    expect(() => resolveNavigationState([GridState])).toThrow(message);
    expect(() => resolveNavigationState(GridState)).toThrow(message);
    const Other = definition("__rsc_ls_other");
    expect(() =>
      resolveNavigationState([Other({ count: 1 }), GridState]),
    ).toThrow(message);
  });

  // Before, only state[0] decided the format: a plain value after an entry
  // was resolved as history.state["undefined"], and an entry after a plain
  // value was stored as plain state that useLocationState never reads.
  it("throws on an array mixing typed entries with other values", () => {
    const GridState = definition("__rsc_ls_grid");
    const message = (index: number) =>
      `[rango] navigation state mixes location-state entries with other values (index ${index}). ` +
      "Pass only entries ({ state: [MyState(value), Other(value)] }); plain state cannot sit next to typed entries.";
    expect(() =>
      resolveNavigationState([GridState({ count: 1 }), { from: "list" }]),
    ).toThrow(message(1));
    expect(() =>
      resolveNavigationState([{ from: "list" }, GridState({ count: 1 })]),
    ).toThrow(message(0));
    const plain = [{ from: "list" }, 2];
    expect(resolveNavigationState(plain)).toBe(plain);
  });

  it("names an unset key instead of throwing the missing-key error", () => {
    const Unkeyed = createLocationState<{ count: number }>();
    expect(() => resolveNavigationState([Unkeyed])).toThrow('(key "unset")');
  });

  it("accepts typed entries in an array and resolved typed records", () => {
    const GridState = definition("__rsc_ls_grid");
    expect(resolveNavigationState([GridState({ count: 3 })])).toEqual({
      __rsc_ls_grid: { count: 3 },
    });
    const resolved = { __rsc_ls_grid: { count: 3 } };
    expect(resolveNavigationState(resolved)).toBe(resolved);
  });

  it("skips the checks in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const GridState = definition("__rsc_ls_grid");
    const entry = GridState({ count: 3 });
    expect(resolveNavigationState(entry)).toBe(entry);
    const uncalled = [GridState];
    expect(resolveNavigationState(uncalled)).toBe(uncalled);
  });
});
