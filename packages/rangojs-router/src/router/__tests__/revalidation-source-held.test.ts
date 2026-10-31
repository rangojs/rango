/**
 * evaluateRevalidation marks the match's handler context `_sourceHeld` when a
 * predicate that read the source page (currentParams, currentUrl,
 * fromRouteName) kept the segment (#1331). match-result.ts turns the mark
 * into `sourceHeld`, which scopes a prefetch of the response to its source.
 */
import { describe, expect, it } from "vitest";
import { evaluateRevalidation } from "../revalidation.js";
import type { ShouldRevalidateFn } from "../../types.js";

function evaluate(
  fn: ShouldRevalidateFn,
  extra: { floor?: boolean } = {},
): Promise<{ decision: boolean; context: { _sourceHeld?: true } }> {
  const context: { _sourceHeld?: true } = {};
  return evaluateRevalidation({
    segment: { id: "M0L0", type: "layout", params: {} } as any,
    prevParams: { category: "audio" },
    getPrevSegment: null,
    request: new Request("http://localhost/cart"),
    prevUrl: new URL("http://localhost/c/audio"),
    nextUrl: new URL("http://localhost/cart"),
    revalidations: [{ name: "revalidate0", fn }],
    routeKey: "cart",
    context: context as any,
    ...(extra.floor
      ? { defaultOverride: { value: true, reason: "new", floor: true } }
      : {}),
  }).then((decision) => ({ decision, context }));
}

describe("evaluateRevalidation: a held segment decided from the source", () => {
  it.each([
    [
      "currentParams",
      (({ currentParams }) => currentParams.x === "y") as ShouldRevalidateFn,
    ],
    [
      "currentUrl",
      (({ currentUrl }) => currentUrl.pathname === "/") as ShouldRevalidateFn,
    ],
    [
      "fromRouteName",
      (({ fromRouteName }) => fromRouteName === "home") as ShouldRevalidateFn,
    ],
  ])("reading %s and keeping the segment marks the match", async (_, fn) => {
    const { decision, context } = await evaluate(fn);
    expect(decision).toBe(false);
    expect(context._sourceHeld).toBe(true);
  });

  it("a soft decision that keeps the segment after a source read marks it", async () => {
    const { decision, context } = await evaluate(
      ({ currentParams, defaultShouldRevalidate }) =>
        currentParams.category === "audio" ? { defaultShouldRevalidate } : true,
    );
    expect(decision).toBe(false);
    expect(context._sourceHeld).toBe(true);
  });

  it("reading the source and re-rendering does not mark it", async () => {
    const { decision, context } = await evaluate(
      ({ currentParams }) => currentParams.category === "audio",
    );
    expect(decision).toBe(true);
    expect(context._sourceHeld).toBeUndefined();
  });

  it("keeping the segment without reading the source does not mark it", async () => {
    const { decision, context } = await evaluate(
      ({ nextParams, nextUrl, isAction, toRouteName }) =>
        isAction() || nextUrl.pathname === nextParams.x || toRouteName === "x",
    );
    expect(decision).toBe(false);
    expect(context._sourceHeld).toBeUndefined();
  });

  it("a floored seed the predicate cannot lower does not mark it", async () => {
    const { decision, context } = await evaluate(
      ({ currentParams }) => currentParams.category !== "audio",
      { floor: true },
    );
    expect(decision).toBe(true);
    expect(context._sourceHeld).toBeUndefined();
  });
});
