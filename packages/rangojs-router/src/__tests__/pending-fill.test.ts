import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelPendingFill,
  clearPendingFill,
  setPendingFill,
} from "../browser/pending-fill";

// The one fill request in flight (prefetch: false,
// docs/design/prefetch-false.md "Abort").
describe("pending-fill", () => {
  afterEach(() => cancelPendingFill());

  it("cancels the registered fill once", () => {
    const cancel = vi.fn();
    setPendingFill(cancel);
    cancelPendingFill();
    cancelPendingFill();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("is a no-op with nothing pending", () => {
    expect(() => cancelPendingFill()).not.toThrow();
  });

  it("a newer adoption cancels the fill of the one before it", () => {
    const first = vi.fn();
    const second = vi.fn();
    setPendingFill(first);
    setPendingFill(second);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    cancelPendingFill();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("a fill that settled is no longer cancelled", () => {
    const cancel = vi.fn();
    setPendingFill(cancel);
    clearPendingFill(cancel);
    cancelPendingFill();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("a settled fill does not clear the one registered after it", () => {
    const first = vi.fn();
    const second = vi.fn();
    setPendingFill(first);
    setPendingFill(second);
    clearPendingFill(first);
    cancelPendingFill();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("a cancel that registers a new fill keeps it", () => {
    const next = vi.fn();
    setPendingFill(() => setPendingFill(next));
    cancelPendingFill();
    expect(next).not.toHaveBeenCalled();
    cancelPendingFill();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
