import { describe, expect, it } from "vitest";
import { createLocationState } from "../../browser/react/location-state-shared.js";
import { withLocationStateKey } from "../index.js";

describe("withLocationStateKey", () => {
  it("derives a __rsc_ls_ key from a name and returns the definition", () => {
    const GridState = createLocationState<{ count: number }>();
    expect(withLocationStateKey(GridState, "GridState")).toBe(GridState);
    expect(GridState.__rsc_ls_key).toBe("__rsc_ls_GridState");
    expect(GridState({ count: 3 })).toEqual({
      __rsc_ls_key: "__rsc_ls_GridState",
      __rsc_ls_value: { count: 3 },
    });
  });

  it("uses a name that already carries the prefix as-is", () => {
    const GridState = createLocationState<{ count: number }>();
    withLocationStateKey(GridState, "__rsc_ls_custom");
    expect(GridState.__rsc_ls_key).toBe("__rsc_ls_custom");
  });

  it("assigns a synthetic key that stays the same for the definition", () => {
    const A = createLocationState<{ count: number }>();
    const B = createLocationState<{ count: number }>();
    withLocationStateKey(A);
    withLocationStateKey(B);
    const keyA = A.__rsc_ls_key;
    expect(keyA).toMatch(/^__rsc_ls_test_\d+$/);
    expect(B.__rsc_ls_key).not.toBe(keyA);
    withLocationStateKey(A);
    expect(A.__rsc_ls_key).toBe(keyA);
  });

  it("keeps a key the plugin already injected unless a name is passed", () => {
    const Injected = createLocationState<{ count: number }>();
    Injected.__rsc_ls_key = "__rsc_ls_src/state.ts#Injected";
    withLocationStateKey(Injected);
    expect(Injected.__rsc_ls_key).toBe("__rsc_ls_src/state.ts#Injected");
    withLocationStateKey(Injected, "Renamed");
    expect(Injected.__rsc_ls_key).toBe("__rsc_ls_Renamed");
  });

  // #994: `clearOnReload` is a suffix the definition appends to whatever key
  // it is given, so two definitions of one slot can share a name.
  it("the definition appends its option suffix to the name; re-keying does not stack it", () => {
    const Carried = createLocationState<{ count: number }>({
      clearOnReload: true,
    });
    const Plain = createLocationState<{ count: number }>();
    withLocationStateKey(Carried, "GridState");
    withLocationStateKey(Carried, "GridState");
    withLocationStateKey(Plain, "GridState");
    expect(Carried.__rsc_ls_key).toBe("__rsc_ls_GridState~r");
    expect(Plain.__rsc_ls_key).toBe("__rsc_ls_GridState");

    const Synthetic = withLocationStateKey(
      createLocationState<{ count: number }>({ clearOnReload: true }),
    );
    const key = Synthetic.__rsc_ls_key;
    expect(key).toMatch(/^__rsc_ls_test_\d+~r$/);
    expect(withLocationStateKey(Synthetic).__rsc_ls_key).toBe(key);
  });

  it("rejects a name that contains the reserved suffix separator", () => {
    const Carried = createLocationState<{ count: number }>({
      clearOnReload: true,
    });
    withLocationStateKey(Carried, "GridState");
    const Other = createLocationState<{ count: number }>();
    // Passing a derived key as a name would let a definition without the
    // option read a clearOnReload slot.
    expect(() => withLocationStateKey(Other, Carried.__rsc_ls_key)).toThrow(
      /"~", which is reserved/,
    );
    expect(() => withLocationStateKey(Other, "a~b")).toThrow(/reserved/);
  });
});
