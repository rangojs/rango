/**
 * transition() index allocation.
 *
 * Both forms of transition() draw from the same "transition" counter:
 *   - child form (no children) uses the index for its item name
 *   - wrapper form (with children) uses the index for the layout namespace
 *
 * Each call must consume EXACTLY one index. A regression where the wrapper
 * form allocated a second index (discarding the first) would leave a gap in
 * the counter, so two consecutive transition() calls must produce contiguous
 * indices.
 */
import { describe, it, expect } from "vitest";
import { RangoContext } from "../../server/context.js";
import { parentEntry, withDslStore } from "./dsl-test-helpers.js";
import { transition } from "../dsl-helpers.js";

/** Read the transition counter (number of indices consumed so far). */
function transitionCount(): number {
  const store = RangoContext.getStore() as unknown as {
    counters: Record<string, number>;
  };
  return store.counters.transition ?? 0;
}

describe("transition() index allocation", () => {
  it("child form consumes exactly one index", () => {
    withDslStore(parentEntry(), () => {
      expect(transitionCount()).toBe(0);
      transition({ viewTransition: false });
      expect(transitionCount()).toBe(1);
    });
  });

  it("wrapper form consumes exactly one index (no discarded index)", () => {
    withDslStore(parentEntry(), () => {
      expect(transitionCount()).toBe(0);
      // Wrapper form: a child-form transition() supplies a valid use item.
      transition(() => [transition({ viewTransition: false })]);
      // The inner child-form call consumes index 1, the wrapper consumes
      // index 0 -> total 2. Before the fix the wrapper burned an extra
      // index, leaving the counter at 3.
      expect(transitionCount()).toBe(2);
    });
  });

  it("two consecutive wrapper transitions get contiguous namespaces", () => {
    const parent = parentEntry();
    withDslStore(parent, () => {
      transition(() => [transition({ viewTransition: false })]);
      transition(() => [transition({ viewTransition: false })]);
    });
    // Two wrapper entries were attached as orphan siblings on the parent's
    // layout[]. Their namespaces must use contiguous indices with no gap.
    const wrapperIndices = parent.layout
      .map((e) => e.id)
      .map((id) => Number(id.slice(id.lastIndexOf(".") + 1)))
      .sort((a, b) => a - b);
    for (let i = 1; i < wrapperIndices.length; i++) {
      expect(wrapperIndices[i] - wrapperIndices[i - 1]).toBe(2);
    }
  });
});
