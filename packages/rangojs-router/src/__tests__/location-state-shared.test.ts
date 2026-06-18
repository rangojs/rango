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
