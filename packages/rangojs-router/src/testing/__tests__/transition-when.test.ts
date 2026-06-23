import { describe, it, expect } from "vitest";
import { runInRequestContext, runTransitionWhen } from "../index.js";
import { createVar } from "../../context-var.js";
import { getRequestContext } from "../../server/request-context.js";
import { applyViewTransitionDefault } from "../../router/segment-resolution/view-transition-default.js";
import { gateTransitions } from "../../rsc/transition-gate.js";
import type { ResolvedSegment } from "../../types/segments.js";

const HoldMark = createVar<boolean>();

/**
 * Exercises the full server-side transition({ when }) mechanism inside a real
 * request context — the same one a consumer's handler runs in:
 *
 *   1. resolution (applyViewTransitionDefault): strips the `when` FUNCTION from
 *      the serialized config (so it never crosses Flight or the segment cache)
 *      and records the predicate keyed by segment id;
 *   2. post-handler gate (gateTransitions): evaluates each predicate against the
 *      request context (seeing what the handler ctx.set) and drops the segment's
 *      transition when it returns false.
 *
 * The full request -> match -> rsc-rendering pipeline that wires these together
 * only runs under real RSC rendering (dispatch refuses component routes; the
 * primitives mock the Flight serializer), so the end-to-end contract is pinned
 * by the dev+prod e2e (e2e/conditional-transition.test.ts). This unit test pins
 * the two server functions and their request-context interaction directly.
 */
async function resolveAndGate(markValue: boolean) {
  const { result } = await runInRequestContext(() => {
    const ctx = getRequestContext();
    ctx.set(HoldMark, markValue); // what a route handler sets, before the gate
    const serialized = applyViewTransitionDefault(
      { enter: "fade", when: (c) => c.get(HoldMark) === true },
      undefined,
      "route-seg",
    );
    const segment = {
      id: "route-seg",
      namespace: "r",
      type: "route",
      index: 0,
      component: null,
      transition: serialized,
    } as ResolvedSegment;
    gateTransitions([segment], ctx);
    return {
      serialized,
      collectedIds: ctx._transitionWhen?.map((p) => p.id),
      transitionAfterGate: segment.transition,
    };
  });
  return result!;
}

describe("transition({ when }) server gate", () => {
  it("strips the `when` function from the serialized config (never crosses the wire)", async () => {
    const { serialized } = await resolveAndGate(true);
    expect(serialized).toBeDefined();
    expect("when" in serialized!).toBe(false);
    // The rest of the config is preserved.
    expect(serialized!.enter).toBe("fade");
  });

  it("collects the predicate keyed by segment id during resolution", async () => {
    const { collectedIds } = await resolveAndGate(true);
    expect(collectedIds).toEqual(["route-seg"]);
  });

  it("keeps the transition when the post-handler predicate returns true", async () => {
    const { transitionAfterGate } = await resolveAndGate(true);
    expect(transitionAfterGate?.enter).toBe("fade");
  });

  it("drops the transition when the post-handler predicate returns false", async () => {
    const { transitionAfterGate } = await resolveAndGate(false);
    expect(transitionAfterGate).toBeUndefined();
  });

  it("reports a throwing predicate to onError (phase 'rendering') and drops the transition", async () => {
    const reported: Array<{ message: string; phase: string }> = [];
    const { result } = await runInRequestContext(() => {
      const ctx = getRequestContext();
      const serialized = applyViewTransitionDefault(
        {
          enter: "fade",
          when: () => {
            throw new Error("boom");
          },
        },
        undefined,
        "route-seg",
      );
      const segment = {
        id: "route-seg",
        namespace: "r",
        type: "route",
        index: 0,
        component: null,
        transition: serialized,
      } as ResolvedSegment;
      gateTransitions([segment], ctx, (errCtx) => {
        reported.push({ message: errCtx.error.message, phase: errCtx.phase });
      });
      return segment.transition;
    });
    // Conservative: a throwing predicate degrades to "no transition".
    expect(result).toBeUndefined();
    // ...and the failure is surfaced via onError rather than swallowed.
    expect(reported).toEqual([{ message: "boom", phase: "rendering" }]);
  });
});

/**
 * The same contract through the PUBLIC @rangojs/router/testing primitive a
 * consumer would use to test their own transition({ when }) predicate. It drives
 * the real applyViewTransitionDefault + gateTransitions, so the predicate sees
 * the production-assembled TransitionWhenContext — no internal functions or
 * private _gate* fields touched here.
 */
describe("runTransitionWhen (public testing primitive)", () => {
  it("keeps the transition when there is no `when`", () => {
    expect(runTransitionWhen({ enter: "fade" }).kept).toBe(true);
  });

  it("passes the revalidate-shaped navigation + action metadata (plus get) to the predicate", () => {
    const { kept, whenContext } = runTransitionWhen(
      {
        when: () => true,
      },
      {
        request: new Request("https://app.test/products/2", {
          method: "POST",
        }),
        params: { id: "2" },
        toRouteName: "products.detail",
        currentUrl: "/products",
        currentParams: { id: "1" },
        fromRouteName: "products.list",
        actionId: "src/actions/cart.ts#addToCart",
        actionUrl: "/cart",
        actionResult: { ok: true },
        formData: new FormData(),
        vars: [[HoldMark, true]],
      },
    );
    expect(kept).toBe(true);
    // source
    expect(whenContext?.currentUrl?.pathname).toBe("/products");
    expect(whenContext?.currentParams).toEqual({ id: "1" });
    expect(whenContext?.fromRouteName).toBe("products.list");
    // target
    expect(whenContext?.nextUrl.pathname).toBe("/products/2");
    expect(whenContext?.nextParams).toEqual({ id: "2" });
    expect(whenContext?.toRouteName).toBe("products.detail");
    // action
    expect(whenContext?.actionId).toBe("src/actions/cart.ts#addToCart");
    expect(whenContext?.actionUrl?.pathname).toBe("/cart");
    expect(whenContext?.actionResult).toEqual({ ok: true });
    expect(whenContext?.formData).toBeInstanceOf(FormData);
    expect(whenContext?.method).toBe("POST");
    // get reads what a handler/middleware set this request
    expect(whenContext?.get(HoldMark)).toBe(true);
  });

  it("leaves the source/action halves undefined for an initial full load with no action", () => {
    const { whenContext } = runTransitionWhen({
      when: () => true,
    });
    expect(whenContext?.currentUrl).toBeUndefined();
    expect(whenContext?.currentParams).toBeUndefined();
    expect(whenContext?.fromRouteName).toBeUndefined();
    expect(whenContext?.actionId).toBeUndefined();
    expect(whenContext?.actionResult).toBeUndefined();
    // Target is always present.
    expect(whenContext?.nextUrl).toBeInstanceOf(URL);
  });

  it("gates on the navigation source (currentUrl)", () => {
    const keptFrom = (currentUrl: string) =>
      runTransitionWhen(
        { when: (c) => c.currentUrl?.pathname === "/list" },
        { currentUrl },
      ).kept;
    expect(keptFrom("/list")).toBe(true);
    expect(keptFrom("/other")).toBe(false);
  });

  it("gates on the action that triggered the revalidation (actionId)", () => {
    const keptFor = (actionId: string) =>
      runTransitionWhen(
        { when: (c) => c.actionId?.includes("addToCart") === true },
        { actionId },
      ).kept;
    expect(keptFor("src/actions/cart.ts#addToCart")).toBe(true);
    expect(keptFor("src/actions/cart.ts#removeFromCart")).toBe(false);
  });

  it("drops the transition and reports a throwing predicate to onError (phase 'rendering')", () => {
    const reported: string[] = [];
    const { kept } = runTransitionWhen(
      {
        when: () => {
          throw new Error("boom");
        },
      },
      {
        onError: (e) => {
          reported.push(`${e.phase}:${e.error.message}`);
        },
      },
    );
    expect(kept).toBe(false);
    expect(reported).toEqual(["rendering:boom"]);
  });
});
