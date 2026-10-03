import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLocationState,
  isLocationStateEntry,
  resolveLocationStateEntries,
} from "../browser/react/location-state-shared";

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "window",
);

function restoreWindow(): void {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    delete (globalThis as Record<string, unknown>).window;
  }
}

describe("location-state-shared", () => {
  afterEach(() => {
    restoreWindow();
    vi.unstubAllEnvs();
  });

  it("throws in development when key is not injected", () => {
    vi.stubEnv("NODE_ENV", "development");
    const ProductState = createLocationState<{ name: string }>();
    expect(() => ProductState({ name: "Widget" })).toThrow(
      "createLocationState key not set",
    );
  });

  // #993: outside development the missing key used to return undefined, so a
  // unit test without the Vite plugin silently read and wrote
  // history.state["undefined"].
  it("throws under test (NODE_ENV=test) for every key read, naming the testing helper", () => {
    vi.stubEnv("NODE_ENV", "test");
    const ProductState = createLocationState<{ name: string }>();
    vi.stubGlobal("window", {
      history: { state: { undefined: { name: "stale" } } },
    });
    const message =
      /createLocationState key not set[\s\S]*withLocationStateKey\(MyState\) from @rangojs\/router\/testing/;
    expect(() => ProductState({ name: "Widget" })).toThrow(message);
    expect(() => ProductState.read()).toThrow(message);
    expect(() => ProductState.__rsc_ls_key).toThrow(message);
  });

  it("does not throw in production (the plugin always injects the key there)", () => {
    vi.stubEnv("NODE_ENV", "production");
    const ProductState = createLocationState<{ name: string }>();
    expect(ProductState({ name: "Widget" })).toEqual({
      __rsc_ls_key: undefined,
      __rsc_ls_value: { name: "Widget" },
    });
  });

  it("creates entries after key injection and resolves lazy entries", () => {
    const ProductState = createLocationState<{ id: number }>();
    (ProductState as any).__rsc_ls_key = "product";

    const eager = ProductState({ id: 42 });
    const lazy = ProductState(() => ({ id: 99 }));

    expect(eager).toEqual({
      __rsc_ls_key: "product",
      __rsc_ls_value: { id: 42 },
    });
    expect(lazy.__rsc_ls_lazy).toBe(true);

    expect(resolveLocationStateEntries([eager, lazy])).toEqual({
      product: { id: 99 },
    });
  });

  it("reads typed state from history", () => {
    const ProductState = createLocationState<{ id: string }>();
    (ProductState as any).__rsc_ls_key = "product";

    vi.stubGlobal("window", {
      history: {
        state: {
          product: { id: "p1" },
        },
      },
    });

    expect(ProductState.read()).toEqual({ id: "p1" });
  });

  it("read(location) reads a snapshot's state (a transition({ when }) from/to), not history.state", () => {
    const ProductState = createLocationState<{ id: string }>();
    (ProductState as any).__rsc_ls_key = "product";
    vi.stubGlobal("window", {
      history: { state: { product: { id: "current" } } },
    });

    expect(ProductState.read({ state: { product: { id: "to" } } })).toEqual({
      id: "to",
    });
    expect(ProductState.read({ state: null })).toBeUndefined();
    expect(ProductState.read({ state: "primitive" })).toBeUndefined();
    // Works without a window (a snapshot read never touches history).
    vi.unstubAllGlobals();
    expect(ProductState.read({ state: { product: { id: "p" } } })).toEqual({
      id: "p",
    });
  });

  it("read(location) of a flash definition never clears the slot", () => {
    const Flash = createLocationState<string>({ flash: true });
    (Flash as any).__rsc_ls_key = "flash";
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      history: { state: { flash: "hi" }, replaceState },
      location: { href: "http://localhost/" },
    });
    const state = { flash: "hi" };
    expect(Flash.read({ state })).toBe("hi");
    expect(state).toEqual({ flash: "hi" });
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("validates location state entry shape", () => {
    expect(
      isLocationStateEntry({ __rsc_ls_key: "key", __rsc_ls_value: "value" }),
    ).toBe(true);
    expect(
      isLocationStateEntry({ __rsc_ls_key: 1, __rsc_ls_value: "value" }),
    ).toBe(false);
    expect(isLocationStateEntry(null)).toBe(false);
  });

  describe("write()", () => {
    it("writes value under the slot's key, merging with existing history.state", () => {
      const ProductState = createLocationState<{ id: string }>();
      (ProductState as any).__rsc_ls_key = "product";

      const replaceState = vi.fn();
      vi.stubGlobal("window", {
        history: {
          state: { __rango_key: "abc", other: { keep: true } },
          replaceState,
        },
        location: { href: "https://example.test/page" },
      });

      ProductState.write({ id: "p1" });

      expect(replaceState).toHaveBeenCalledTimes(1);
      expect(replaceState).toHaveBeenCalledWith(
        {
          __rango_key: "abc",
          other: { keep: true },
          product: { id: "p1" },
        },
        "",
        "https://example.test/page",
      );
    });

    it("replaces the slot's value (no deep merge of T)", () => {
      const ProductState = createLocationState<{ id: string; name?: string }>();
      (ProductState as any).__rsc_ls_key = "product";

      const replaceState = vi.fn();
      vi.stubGlobal("window", {
        history: {
          state: { product: { id: "p1", name: "Widget" } },
          replaceState,
        },
        location: { href: "https://example.test/page" },
      });

      ProductState.write({ id: "p2" });

      expect(replaceState).toHaveBeenCalledWith(
        { product: { id: "p2" } },
        "",
        "https://example.test/page",
      );
    });

    it("handles null history.state by initializing a fresh dict", () => {
      const ProductState = createLocationState<{ id: string }>();
      (ProductState as any).__rsc_ls_key = "product";

      const replaceState = vi.fn();
      vi.stubGlobal("window", {
        history: { state: null, replaceState },
        location: { href: "https://example.test/page" },
      });

      ProductState.write({ id: "p1" });

      expect(replaceState).toHaveBeenCalledWith(
        { product: { id: "p1" } },
        "",
        "https://example.test/page",
      );
    });

    it("replaces a non-null primitive history.state with a fresh dict", () => {
      // Mirror the delete() F6 guard: non-Rango code may call
      // pushState/replaceState with a primitive, so `?? {}` (catches only
      // null/undefined) would spread a string into indexed char keys
      // ({0:"s",1:"o",...,product:...}), corrupting history.state. The guard
      // must coerce any non-object to a fresh dict.
      const ProductState = createLocationState<{ id: string }>();
      (ProductState as any).__rsc_ls_key = "product";

      const replaceState = vi.fn();
      vi.stubGlobal("window", {
        history: { state: "some-string", replaceState },
        location: { href: "https://example.test/page" },
      });

      ProductState.write({ id: "p1" });

      expect(replaceState).toHaveBeenCalledWith(
        { product: { id: "p1" } },
        "",
        "https://example.test/page",
      );
    });

    it("replaces a number primitive history.state with a fresh dict", () => {
      const ProductState = createLocationState<{ id: string }>();
      (ProductState as any).__rsc_ls_key = "product";

      const replaceState = vi.fn();
      vi.stubGlobal("window", {
        history: { state: 42, replaceState },
        location: { href: "https://example.test/page" },
      });

      ProductState.write({ id: "p1" });

      expect(replaceState).toHaveBeenCalledWith(
        { product: { id: "p1" } },
        "",
        "https://example.test/page",
      );
    });

    it("throws on the server (no window)", () => {
      const ProductState = createLocationState<{ id: string }>();
      (ProductState as any).__rsc_ls_key = "product";

      restoreWindow();
      delete (globalThis as Record<string, unknown>).window;

      expect(() => ProductState.write({ id: "p1" })).toThrow(
        "LocationState.write() is client-only",
      );
    });
  });

  describe("delete()", () => {
    it("removes only this slot's key, preserving other history.state entries", () => {
      const ProductState = createLocationState<{ id: string }>();
      (ProductState as any).__rsc_ls_key = "product";

      const replaceState = vi.fn();
      vi.stubGlobal("window", {
        history: {
          state: {
            __rango_key: "abc",
            product: { id: "p1" },
            other: { keep: true },
          },
          replaceState,
        },
        location: { href: "https://example.test/page" },
      });

      ProductState.delete();

      expect(replaceState).toHaveBeenCalledTimes(1);
      expect(replaceState).toHaveBeenCalledWith(
        { __rango_key: "abc", other: { keep: true } },
        "",
        "https://example.test/page",
      );
    });

    it("is a no-op when the slot is absent", () => {
      const ProductState = createLocationState<{ id: string }>();
      (ProductState as any).__rsc_ls_key = "product";

      const replaceState = vi.fn();
      vi.stubGlobal("window", {
        history: { state: { __rango_key: "abc" }, replaceState },
        location: { href: "https://example.test/page" },
      });

      ProductState.delete();

      expect(replaceState).not.toHaveBeenCalled();
    });

    it("is a no-op when history.state is null", () => {
      const ProductState = createLocationState<{ id: string }>();
      (ProductState as any).__rsc_ls_key = "product";

      const replaceState = vi.fn();
      vi.stubGlobal("window", {
        history: { state: null, replaceState },
        location: { href: "https://example.test/page" },
      });

      ProductState.delete();

      expect(replaceState).not.toHaveBeenCalled();
    });

    /**
     * F6: history.state may be a non-null primitive if non-Rango code called
     * history.pushState/replaceState with a string/number/boolean. The old
     * guard (`current == null || !(key in current)`) ran `key in <primitive>`,
     * which throws TypeError ("Cannot use 'in' operator ... in <primitive>")
     * and escaped delete() as an uncaught error instead of a no-op. The guard
     * must require an object before the `in` check.
     */
    it("is a no-op when history.state is a non-null primitive (string)", () => {
      const ProductState = createLocationState<{ id: string }>();
      (ProductState as any).__rsc_ls_key = "product";

      const replaceState = vi.fn();
      vi.stubGlobal("window", {
        history: { state: "some-string-state" as unknown, replaceState },
        location: { href: "https://example.test/page" },
      });

      expect(() => ProductState.delete()).not.toThrow();
      expect(replaceState).not.toHaveBeenCalled();
    });

    it("is a no-op when history.state is a number primitive", () => {
      const ProductState = createLocationState<{ id: string }>();
      (ProductState as any).__rsc_ls_key = "product";

      const replaceState = vi.fn();
      vi.stubGlobal("window", {
        history: { state: 42 as unknown, replaceState },
        location: { href: "https://example.test/page" },
      });

      expect(() => ProductState.delete()).not.toThrow();
      expect(replaceState).not.toHaveBeenCalled();
    });

    it("throws on the server (no window)", () => {
      const ProductState = createLocationState<{ id: string }>();
      (ProductState as any).__rsc_ls_key = "product";

      restoreWindow();
      delete (globalThis as Record<string, unknown>).window;

      expect(() => ProductState.delete()).toThrow(
        "LocationState.delete() is client-only",
      );
    });
  });
});

type GridSnapshot = { rows: number[] };

function historyWithReplace(): {
  state: unknown;
  replaceState: ReturnType<typeof vi.fn>;
} {
  const history: {
    state: unknown;
    replaceState: ReturnType<typeof vi.fn>;
  } = {
    state: { idx: 1 },
    replaceState: vi.fn(),
  };
  history.replaceState.mockImplementation((next: unknown) => {
    history.state = next;
  });
  return history;
}

function isGridSnapshot(value: unknown): value is GridSnapshot {
  return (
    value !== null &&
    typeof value === "object" &&
    Array.isArray((value as { rows?: unknown }).rows)
  );
}

// #994: `version` and `clearOnReload` live in the storage KEY, never in the
// stored value. The key is the persistence contract: slots outlive deploys, so
// the exact strings are pinned here.
describe("createLocationState storage key", () => {
  // What the Vite plugin injects: `__rsc_ls_<path or hash>#<ExportName>`.
  const INJECTED = "__rsc_ls_a1b2c3d4#Grid";

  afterEach(() => {
    restoreWindow();
    vi.unstubAllEnvs();
  });

  function define(
    options?: Parameters<typeof createLocationState<GridSnapshot>>[0],
  ) {
    const definition = createLocationState<GridSnapshot>(options);
    definition.__rsc_ls_key = INJECTED;
    return definition;
  }

  function stubHistory(state: Record<string, unknown> = { idx: 1 }) {
    const history = historyWithReplace();
    history.state = state;
    vi.stubGlobal("window", {
      history,
      location: { href: "https://example.test/grid" },
    });
    return history;
  }

  it.each([
    ["no options", undefined, INJECTED],
    ["flash", { flash: true }, INJECTED],
    ["validate", { validate: isGridSnapshot }, INJECTED],
    ["clearOnReload: false", { clearOnReload: false }, INJECTED],
    ["version", { version: 2 }, `${INJECTED}~v2`],
    ["version 0", { version: 0 }, `${INJECTED}~v0`],
    ["a fractional version", { version: 1.5 }, `${INJECTED}~v1.5`],
    ["flash + version", { flash: true, version: 2 }, `${INJECTED}~v2`],
    [
      "version + validate",
      { version: 2, validate: isGridSnapshot },
      `${INJECTED}~v2`,
    ],
    ["clearOnReload", { clearOnReload: true }, `${INJECTED}~r`],
    [
      "version + clearOnReload",
      { version: 2, clearOnReload: true },
      `${INJECTED}~v2~r`,
    ],
  ] as const)(
    "%s: every writer stores the raw value under one key",
    (_label, options, key) => {
      const Grid = define(options);
      const history = stubHistory();
      const snapshot = { rows: [1, 2] };

      expect(Grid.__rsc_ls_key).toBe(key);
      expect(Grid(snapshot)).toEqual({
        __rsc_ls_key: key,
        __rsc_ls_value: snapshot,
      });
      expect(Grid(snapshot).__rsc_ls_value).toBe(snapshot);
      const lazy = Grid(() => snapshot);
      expect(lazy.__rsc_ls_lazy).toBe(true);
      expect(resolveLocationStateEntries([lazy])[key]).toBe(snapshot);

      Grid.write(snapshot);
      expect(history.replaceState).toHaveBeenCalledTimes(1);
      expect(history.state).toEqual({ idx: 1, [key]: snapshot });
      expect((history.state as Record<string, unknown>)[key]).toBe(snapshot);
      expect(Grid.read()).toBe(snapshot);
      expect(Grid.read({ state: history.state })).toBe(snapshot);

      Grid.delete();
      expect(history.state).toEqual({ idx: 1 });
      expect(Grid.read()).toBeUndefined();
    },
  );

  it("a release without the options never sees a slot written with one", () => {
    for (const options of [{ version: 2 }, { clearOnReload: true }]) {
      const history = stubHistory();
      define(options).write({ rows: [1] });

      // The pre-feature read: history.state[<injected key>], unchecked.
      expect(
        (history.state as Record<string, unknown>)[INJECTED],
      ).toBeUndefined();
      expect(define().read()).toBeUndefined();
    }
  });

  it("each version reads only its own slot, and versions coexist in one entry", () => {
    const history = stubHistory();
    const [V1, V2, Unversioned] = [
      define({ version: 1 }),
      define({ version: 2 }),
      define(),
    ];
    const [one, two, plain] = [{ rows: [1] }, { rows: [2] }, { rows: [0] }];

    V1.write(one);
    expect(V2.read()).toBeUndefined();
    expect(Unversioned.read()).toBeUndefined();

    V2.write(two);
    Unversioned.write(plain);
    expect(V1.read()).toBe(one);
    expect(V2.read()).toBe(two);
    expect(Unversioned.read()).toBe(plain);
    expect(history.state).toEqual({
      idx: 1,
      [`${INJECTED}~v1`]: one,
      [`${INJECTED}~v2`]: two,
      [INJECTED]: plain,
    });
  });

  it("a slot written before the definition adopted an option is not read", () => {
    stubHistory();
    const before = { rows: [9] };
    define().write(before);

    expect(define({ clearOnReload: true }).read()).toBeUndefined();
    expect(define({ version: 1 }).read()).toBeUndefined();
  });

  it("after an option is removed the definition reads the plain key again", () => {
    stubHistory();
    const [written, plain] = [{ rows: [1] }, { rows: [2] }];
    define({ clearOnReload: true }).write(written);
    const Removed = define();

    expect(Removed.read()).toBeUndefined();
    Removed.write(plain);
    expect(Removed.read()).toBe(plain);
    expect(define({ clearOnReload: true }).read()).toBe(written);
  });

  it("rejects flash with clearOnReload outside production", () => {
    const both = { flash: true, clearOnReload: true };
    expect(() => createLocationState<string>(both)).toThrow(
      /`flash` and `clearOnReload` cannot be combined/,
    );
    vi.stubEnv("NODE_ENV", "production");
    expect(() => createLocationState<string>(both)).not.toThrow();
  });
});

describe("createLocationState validate", () => {
  afterEach(() => {
    restoreWindow();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function stubHistory(state: unknown): void {
    vi.stubGlobal("window", { history: { state } });
  }

  it("reads the value it accepts and undefined for the one it rejects", () => {
    const Grid = createLocationState<GridSnapshot>({
      validate: isGridSnapshot,
    });
    Grid.__rsc_ls_key = "grid";
    const snapshot = { rows: [1] };

    for (const [stored, read] of [
      [snapshot, snapshot],
      [{ rows: "nope" }, undefined],
    ] as const) {
      const state = { grid: stored };
      stubHistory(state);
      expect(Grid.read()).toBe(read);
      expect(Grid.read({ state })).toBe(read);
    }
  });

  it("is never called for an empty slot, or for another version's slot", () => {
    const seen = vi.fn();
    const validate = (value: unknown): value is GridSnapshot => {
      seen(value);
      return true;
    };
    const Grid = createLocationState<GridSnapshot>({ validate, version: 2 });
    Grid.__rsc_ls_key = "grid";

    for (const state of [
      null,
      {},
      "primitive",
      { grid: { rows: [1] }, "grid~v1": { rows: [1] } },
    ]) {
      stubHistory(state);
      expect(Grid.read()).toBeUndefined();
      expect(Grid.read({ state })).toBeUndefined();
    }
    expect(seen).not.toHaveBeenCalled();
  });

  it("a throw reads as undefined and is reported once per definition, naming its key", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new TypeError("rows is undefined");
    const throwing = (_value: unknown): _value is GridSnapshot => {
      throw boom;
    };
    const Grid = createLocationState<GridSnapshot>({ validate: throwing });
    Grid.__rsc_ls_key = "__rsc_ls_grid";
    const Other = createLocationState<GridSnapshot>({
      validate: throwing,
      version: 2,
    });
    Other.__rsc_ls_key = "__rsc_ls_other";
    const state = { __rsc_ls_grid: { rows: 1 }, "__rsc_ls_other~v2": 1 };
    stubHistory(state);

    expect(Grid.read()).toBeUndefined();
    expect(Grid.read({ state })).toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain('"__rsc_ls_grid"');
    expect(error.mock.calls[0]?.[1]).toBe(boom);

    expect(Other.read()).toBeUndefined();
    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[1]?.[0]).toContain('"__rsc_ls_other~v2"');
  });

  it("does not report a throw in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const Grid = createLocationState<GridSnapshot>({
      validate: (_value): _value is GridSnapshot => {
        throw new Error("boom");
      },
    });
    Grid.__rsc_ls_key = "grid";
    stubHistory({ grid: { rows: [1] } });

    expect(Grid.read()).toBeUndefined();
    expect(error).not.toHaveBeenCalled();
  });
});
