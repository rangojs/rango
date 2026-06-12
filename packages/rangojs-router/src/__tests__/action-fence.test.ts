import { afterEach, describe, expect, it } from "vitest";
import {
  __resetActionFence,
  enterActionFence,
  exitActionFence,
  isActionFenceActive,
} from "../browser/action-fence.js";

describe("action-fence", () => {
  afterEach(() => __resetActionFence());

  it("is inactive by default", () => {
    expect(isActionFenceActive()).toBe(false);
  });

  it("is active while at least one action holds it", () => {
    enterActionFence();
    expect(isActionFenceActive()).toBe(true);
    exitActionFence();
    expect(isActionFenceActive()).toBe(false);
  });

  it("is refcounted: stays up until every concurrent action exits", () => {
    enterActionFence(); // action A
    enterActionFence(); // action B
    expect(isActionFenceActive()).toBe(true);

    exitActionFence(); // A (or a keep action) resolves
    // Still up: a non-keep action is still pending.
    expect(isActionFenceActive()).toBe(true);

    exitActionFence(); // B resolves
    expect(isActionFenceActive()).toBe(false);
  });

  it("never underflows below zero", () => {
    exitActionFence();
    exitActionFence();
    expect(isActionFenceActive()).toBe(false);
    enterActionFence();
    expect(isActionFenceActive()).toBe(true);
  });
});
