/**
 * runAsSegment / segmentPinOf (server/context.ts): the segment a streamed
 * handler or a loader body runs for, carried by its async context instead of
 * the handler ctx's shared `_currentSegmentId`.
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

  // A layout's or slot's ctx carries its own segment (`_handleSegmentId`,
  // router/handler-context.ts withSegmentScope) because the walker moves the
  // shared pin on while a component that ctx was handed to still renders.
  it("reads the segment a layout's or slot's ctx carries over the shared pin", () => {
    expect(
      segmentPinOf({
        _currentSegmentId: "M0L0L0R0",
        _handleSegmentId: "M0L0L0",
      }),
    ).toBe("M0L0L0");
    // The pin need not exist: the carried segment is the ctx's own.
    expect(segmentPinOf({ _handleSegmentId: "M0L0L0.@panel" })).toBe(
      "M0L0L0.@panel",
    );
  });

  it("a scope still wins over the segment the ctx carries", () => {
    const carried = {
      _currentSegmentId: "M0L0L0R0",
      _handleSegmentId: "M0L0L0",
    };
    expect(runAsSegment("M0L0L0D0.products", () => segmentPinOf(carried))).toBe(
      "M0L0L0D0.products",
    );
    expect(runAsSegment(undefined, () => segmentPinOf(carried))).toBe("M0L0L0");
  });
});
