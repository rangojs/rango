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
});
