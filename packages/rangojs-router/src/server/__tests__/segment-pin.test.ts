/**
 * runAsSegment / segmentPinOf (server/context.ts): the segment a streamed
 * handler or a loader body runs for, carried by its async context instead of
 * the handler ctx's shared `_currentSegmentId`; and the segment a layout's or
 * slot's ctx carries (`_handleSegmentId`, withSegmentScope), which outlives
 * the walk's pin.
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

  it("a ctx that carries its own segment answers with it, not the moved pin", () => {
    // A layout's ctx read after the walker pinned the route it renders.
    expect(
      segmentPinOf({ _currentSegmentId: "M0L0L0R0", _handleSegmentId: "M0L0" }),
    ).toBe("M0L0");
    // A scope around the read still wins: it names the frame the code runs in.
    expect(
      runAsSegment("M0L0L0.@modal", () =>
        segmentPinOf({
          _currentSegmentId: "M0L0L0R0",
          _handleSegmentId: "M0L0",
        }),
      ),
    ).toBe("M0L0L0.@modal");
  });
});
