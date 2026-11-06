/**
 * runAsSegment / segmentPinOf (server/context.ts): the segment a streamed
 * handler or a loader body runs for, carried by its async context instead of
 * the handler ctx's shared `_currentSegmentId`; and the segment a ctx OBJECT
 * belongs to, which outlives the pin it was created under — a layout's or
 * parallel slot's ctx (`_handleSegmentId`) and the request's one handler ctx
 * once the walker ran a route on it (`_pushSegmentId`).
 */
import { describe, expect, it } from "vitest";
import { runAsSegment, segmentPinOf } from "../context.js";

describe("segmentPinOf", () => {
  it("reads the ctx's pin outside any scope", () => {
    expect(segmentPinOf({ _currentSegmentId: "R0" })).toBe("R0");
    expect(segmentPinOf({})).toBeUndefined();
  });

  it("reads the scope's segment after the shared pin moves, across awaits", async () => {
    const ctx = { _currentSegmentId: "R0" };
    const seen: Array<string | undefined> = [];
    const handler = runAsSegment("R0", async () => {
      await Promise.resolve();
      seen.push(segmentPinOf(ctx));
      await new Promise((resolve) => setTimeout(resolve, 0));
      seen.push(segmentPinOf(ctx));
    });
    // The walker moves on without awaiting the handler.
    ctx._currentSegmentId = "R0.@side";
    await handler;
    expect(seen).toEqual(["R0", "R0"]);
    expect(segmentPinOf(ctx)).toBe("R0.@side");
  });

  it("the innermost scope wins; an undefined segment falls back to the ctx", () => {
    const ctx = { _currentSegmentId: "R0.@side" };
    expect(
      runAsSegment("R0", () => runAsSegment("L0", () => segmentPinOf(ctx))),
    ).toBe("L0");
    expect(runAsSegment(undefined, () => segmentPinOf(ctx))).toBe("R0.@side");
  });

  it("a layout's or slot's ctx keeps its own segment after the pin moves", () => {
    // withSegmentScope's child: `_handleSegmentId` is its own, the pin is read
    // through the prototype and the walker moves it on.
    const base = { _currentSegmentId: "M0L0L0R0" };
    const scoped = Object.assign(Object.create(base), {
      _handleSegmentId: "M0L0L0",
    });
    expect(segmentPinOf(scoped)).toBe("M0L0L0");
    base._currentSegmentId = "M0L0L0R0.@aside";
    expect(segmentPinOf(scoped)).toBe("M0L0L0");
    // A copy carries it too.
    expect(segmentPinOf({ ...scoped })).toBe("M0L0L0");
  });

  it("the request's one handler ctx keeps the route's segment", () => {
    // resolveEntryHandler stamps `_pushSegmentId` before the route handler
    // runs; its orphan layouts and its slots move the pin on afterwards.
    const ctx = { _currentSegmentId: "M0L0L0R0", _pushSegmentId: "M0L0L0R0" };
    expect(segmentPinOf(ctx)).toBe("M0L0L0R0");
    ctx._currentSegmentId = "M0L0L0R0.@aside";
    expect(segmentPinOf(ctx)).toBe("M0L0L0R0");
    // A scoped child's own segment still wins over the route's.
    expect(
      segmentPinOf(
        Object.assign(Object.create(ctx), { _handleSegmentId: "M0L0L0" }),
      ),
    ).toBe("M0L0L0");
  });

  it("the carried segment is for a receiver that is not the ctx itself", () => {
    const ctx = { _currentSegmentId: "M0L0L0R0", _pushSegmentId: "M0L0L0R0" };
    // `ctx.use` called through a copy of a scoped child: the installed ctx
    // knows only the route, the receiver knows the segment.
    expect(segmentPinOf(ctx, "M0L0L0")).toBe("M0L0L0");
    // The scope still wins over everything.
    expect(runAsSegment("M0L0L0L0", () => segmentPinOf(ctx, "M0L0L0"))).toBe(
      "M0L0L0L0",
    );
  });
});
