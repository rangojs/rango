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

describe("createLocationState version", () => {
  afterEach(() => {
    restoreWindow();
    vi.unstubAllEnvs();
  });

  it("write stores { v, value } and read returns the same inner reference", () => {
    const Grid = createLocationState<GridSnapshot>({ version: 2 });
    (Grid as any).__rsc_ls_key = "grid";
    const history = historyWithReplace();
    vi.stubGlobal("window", {
      history,
      location: { href: "https://example.test/grid" },
    });

    const snapshot = { rows: [1, 2] };
    Grid.write(snapshot);

    expect(history.state).toEqual({
      idx: 1,
      grid: { v: 2, value: snapshot },
    });
    expect(Grid.read()).toBe(snapshot);
    expect(Grid.read({ state: history.state })).toBe(snapshot);
    expect(Grid.read()).toBe(Grid.read());

    Grid.delete();
    expect(history.state).toEqual({ idx: 1 });
    expect(Grid.read()).toBeUndefined();
  });

  it("version 0 still stores an envelope", () => {
    const Grid = createLocationState<GridSnapshot>({ version: 0 });
    (Grid as any).__rsc_ls_key = "grid";
    const history = historyWithReplace();
    vi.stubGlobal("window", {
      history,
      location: { href: "https://example.test/grid" },
    });
    const snapshot = { rows: [0] };
    Grid.write(snapshot);
    expect((history.state as { grid: unknown }).grid).toEqual({
      v: 0,
      value: snapshot,
    });
    expect(Grid.read()).toBe(snapshot);
  });

  it("a raw object, a different version, and a non-object read as undefined", () => {
    const Grid = createLocationState<GridSnapshot>({ version: 2 });
    (Grid as any).__rsc_ls_key = "grid";
    const snapshot = { rows: [1] };
    const cases = [
      { grid: snapshot },
      { grid: { v: 1, value: snapshot } },
      { grid: "stale" },
    ];
    for (const state of cases) {
      vi.stubGlobal("window", { history: { state } });
      expect(Grid.read()).toBeUndefined();
      expect(Grid.read({ state })).toBeUndefined();
    }
  });

  it("flash with version stores the envelope and read returns the inner value", () => {
    const Grid = createLocationState<GridSnapshot>({
      flash: true,
      version: 2,
    });
    (Grid as any).__rsc_ls_key = "grid";
    const history = historyWithReplace();
    vi.stubGlobal("window", {
      history,
      location: { href: "https://example.test/grid" },
    });
    const snapshot = { rows: [4] };
    Grid.write(snapshot);
    expect((history.state as { grid: { value: unknown } }).grid.value).toBe(
      snapshot,
    );
    expect(Grid.read()).toBe(snapshot);
    expect(history.state).toEqual({
      idx: 1,
      grid: { v: 2, value: snapshot },
    });
  });

  it("a direct entry and a lazy getter persist the envelope", () => {
    const Grid = createLocationState<GridSnapshot>({ version: 2 });
    (Grid as any).__rsc_ls_key = "grid";
    const snapshot = { rows: [1] };
    const eager = Grid(snapshot);
    expect(eager).toEqual({
      __rsc_ls_key: "grid",
      __rsc_ls_value: { v: 2, value: snapshot },
    });
    expect((eager.__rsc_ls_value as { value: GridSnapshot }).value).toBe(
      snapshot,
    );

    let current = snapshot;
    const lazy = Grid(() => current);
    expect(lazy.__rsc_ls_lazy).toBe(true);
    expect(resolveLocationStateEntries([eager, lazy])).toEqual({
      grid: { v: 2, value: snapshot },
    });

    const next = { rows: [9] };
    current = next;
    const resolved = resolveLocationStateEntries([lazy]);
    expect(resolved).toEqual({ grid: { v: 2, value: next } });
    expect((resolved.grid as { value: GridSnapshot }).value).toBe(next);
  });
});

function isGridSnapshot(value: unknown): value is GridSnapshot {
  return (
    value !== null &&
    typeof value === "object" &&
    Array.isArray((value as { rows?: unknown }).rows)
  );
}

describe("createLocationState validate", () => {
  afterEach(() => {
    restoreWindow();
    vi.unstubAllEnvs();
  });

  it("keeps the raw stored value and returns it only when validate passes", () => {
    const seen = vi.fn();
    const validate = (value: unknown): value is GridSnapshot => {
      seen(value);
      return isGridSnapshot(value);
    };
    const Grid = createLocationState<GridSnapshot>({ validate });
    (Grid as any).__rsc_ls_key = "grid";
    const history = historyWithReplace();
    vi.stubGlobal("window", {
      history,
      location: { href: "https://example.test/grid" },
    });

    const snapshot = { rows: [1] };
    Grid.write(snapshot);
    expect(history.state).toEqual({ idx: 1, grid: snapshot });
    expect(Grid(snapshot).__rsc_ls_value).toBe(snapshot);
    expect(resolveLocationStateEntries([Grid(() => snapshot)])).toEqual({
      grid: snapshot,
    });

    expect(Grid.read()).toBe(snapshot);
    expect(Grid.read({ state: history.state })).toBe(snapshot);
    expect(seen).toHaveBeenCalledWith(snapshot);

    const rejected = { rows: "nope" };
    history.state = { idx: 1, grid: rejected };
    seen.mockClear();
    expect(Grid.read()).toBeUndefined();
    expect(Grid.read({ state: history.state })).toBeUndefined();
    expect(seen).toHaveBeenCalledWith(rejected);
  });

  it("does not unwrap a value that only looks like a version envelope", () => {
    const stored = { v: 2, value: { rows: [1] } };
    const seen = vi.fn();
    const validate = (value: unknown): value is typeof stored => {
      seen(value);
      return value === stored;
    };
    const Grid = createLocationState<typeof stored>({ validate });
    (Grid as any).__rsc_ls_key = "grid";
    const state = { grid: stored };
    vi.stubGlobal("window", { history: { state } });

    expect(Grid.read()).toBe(stored);
    expect(Grid.read({ state })).toBe(stored);
    expect(seen).toHaveBeenCalledWith(stored);
  });
});

describe("createLocationState version and validate", () => {
  afterEach(() => {
    restoreWindow();
    vi.unstubAllEnvs();
  });

  it("does not validate a version mismatch, and drops a match that fails validate", () => {
    const snapshot = { rows: [1] };
    const seen = vi.fn();
    const validate = (value: unknown): value is GridSnapshot => {
      seen(value);
      return isGridSnapshot(value);
    };
    const Grid = createLocationState<GridSnapshot>({ version: 2, validate });
    (Grid as any).__rsc_ls_key = "grid";

    const mismatches = [
      { grid: snapshot },
      { grid: { v: 1, value: snapshot } },
      { grid: "stale" },
    ];
    for (const state of mismatches) {
      vi.stubGlobal("window", { history: { state } });
      expect(Grid.read()).toBeUndefined();
      expect(Grid.read({ state })).toBeUndefined();
    }
    expect(seen).not.toHaveBeenCalled();

    const badInner = { rows: "nope" };
    const matchedBad = { grid: { v: 2, value: badInner } };
    vi.stubGlobal("window", { history: { state: matchedBad } });
    expect(Grid.read()).toBeUndefined();
    expect(Grid.read({ state: matchedBad })).toBeUndefined();
    expect(seen).toHaveBeenCalledWith(badInner);

    seen.mockClear();
    const matched = { grid: { v: 2, value: snapshot } };
    vi.stubGlobal("window", { history: { state: matched } });
    expect(Grid.read()).toBe(snapshot);
    expect(Grid.read({ state: matched })).toBe(snapshot);
    expect(seen).toHaveBeenCalledWith(snapshot);

    const history = historyWithReplace();
    vi.stubGlobal("window", {
      history,
      location: { href: "https://example.test/grid" },
    });
    Grid.write(snapshot);
    expect(Grid(snapshot).__rsc_ls_value).toEqual({ v: 2, value: snapshot });
    expect(resolveLocationStateEntries([Grid(() => snapshot)])).toEqual({
      grid: { v: 2, value: snapshot },
    });
    expect(history.state).toEqual({
      idx: 1,
      grid: { v: 2, value: snapshot },
    });
    expect(Grid.read()).toBe(snapshot);
  });
});
