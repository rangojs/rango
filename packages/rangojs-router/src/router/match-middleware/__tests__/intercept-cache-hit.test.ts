import { describe, expect, it, vi } from "vitest";
import { withInterceptResolution } from "../intercept-resolution.js";
import { runWithRouterContext } from "../../router-context.js";
import { createPipelineState } from "../../match-context.js";
import type { MatchContext } from "../../match-context.js";
import type { ResolvedSegment } from "../../../types.js";
import { seg, gen } from "./helpers.js";

// A cache or prerender hit that carries an intercept's slot: the slot keeps
// its stored component, and its loaders, never stored, resolve as loader
// segments of it (router/intercept-resolution.ts resolveInterceptLoadersOnly).

async function hit(slot: ResolvedSegment) {
  const loaderSegment = seg("L0.@modalD0.a", {
    type: "loader",
    namespace: "intercept:item",
    loaderId: "a",
  });
  const resolveInterceptLoadersOnly = vi.fn(async () => [loaderSegment]);
  const ctx = {
    isFullMatch: false,
    isIntercept: true,
    interceptResult: {
      intercept: { slotName: "@modal", routeName: "item", loader: [] },
      entry: { shortCode: "L0" },
    },
    clientSegmentSet: new Set<string>(),
    Store: { run: <T>(fn: () => T) => fn() },
    matched: { params: {} },
    localRouteName: "item",
  } as unknown as MatchContext<any>;
  const state = createPipelineState();
  state.cacheHit = true;
  const yielded: ResolvedSegment[] = [];
  await runWithRouterContext(
    { resolveInterceptLoadersOnly } as any,
    async () => {
      for await (const s of withInterceptResolution(
        ctx,
        state,
      )(gen([seg("L0", { type: "layout" }), slot]))) {
        yielded.push(s);
      }
    },
  );
  return { yielded, state, loaderSegment };
}

describe("withInterceptResolution on a cache hit", () => {
  it("yields the intercept's loader segments after the stored slot", async () => {
    const slot = seg("L0.@modal", {
      type: "parallel",
      namespace: "intercept:item",
      slot: "@modal",
    });
    const { yielded, state, loaderSegment } = await hit(slot);
    expect(yielded.map((s) => s.id)).toEqual([
      "L0",
      "L0.@modal",
      "L0.@modalD0.a",
    ]);
    expect(state.interceptSegments).toEqual([slot, loaderSegment]);
    expect(state.slots["@modal"]?.segments).toEqual([slot, loaderSegment]);
  });

  it("strips the aggregate a record written before loader segments carries on the slot", async () => {
    const slot = seg("L0.@modal", {
      type: "parallel",
      namespace: "intercept:item",
      slot: "@modal",
      loaderIds: ["a"],
      loaderDataPromise: [{ stale: true }],
    });
    await hit(slot);
    expect(slot).not.toHaveProperty("loaderIds");
    expect(slot).not.toHaveProperty("loaderDataPromise");
  });
});
