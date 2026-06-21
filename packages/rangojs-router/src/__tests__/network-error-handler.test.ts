import { describe, it, expect, vi } from "vitest";
import {
  toNetworkError,
  isBackgroundSuppressible,
  emitNavigationError,
} from "../browser/network-error-handler";
import { RenderErrorThrower } from "../render-error-thrower";
import { NetworkError } from "../errors";

// ---------------------------------------------------------------------------
// toNetworkError
// ---------------------------------------------------------------------------

describe("toNetworkError", () => {
  const ctx = { url: "/api/data", operation: "navigation" as const };

  it("returns null for a plain Error", () => {
    expect(toNetworkError(new Error("boom"), ctx)).toBeNull();
  });

  it("returns null for a non-AbortError DOMException", () => {
    expect(
      toNetworkError(new DOMException("bad", "SyntaxError"), ctx),
    ).toBeNull();
  });

  it("returns the original NetworkError unchanged", () => {
    const err = new NetworkError("offline", {
      url: "/old",
      operation: "action",
    });
    const result = toNetworkError(err, ctx);
    // Same object identity
    expect(result).toBe(err);
  });

  it("wraps a TypeError('Failed to fetch') as NetworkError", () => {
    const err = new TypeError("Failed to fetch");
    const result = toNetworkError(err, ctx);
    expect(result).toBeInstanceOf(NetworkError);
    expect(result!.url).toBe("/api/data");
    expect(result!.operation).toBe("navigation");
    expect(result!.cause).toBe(err);
  });

  it("wraps a TypeError('Load failed') as NetworkError (Safari)", () => {
    const err = new TypeError("Load failed");
    const result = toNetworkError(err, ctx);
    expect(result).toBeInstanceOf(NetworkError);
  });

  it("wraps a DOMException with name 'NetworkError'", () => {
    const err = new DOMException("network failure", "NetworkError");
    const result = toNetworkError(err, ctx);
    expect(result).toBeInstanceOf(NetworkError);
    expect(result!.url).toBe("/api/data");
  });

  it("uses the provided operation in the wrapped error", () => {
    const err = new TypeError("Failed to fetch");
    const result = toNetworkError(err, {
      url: "/test",
      operation: "revalidation",
    });
    expect(result!.operation).toBe("revalidation");
  });
});

// ---------------------------------------------------------------------------
// isBackgroundSuppressible
// ---------------------------------------------------------------------------

describe("isBackgroundSuppressible", () => {
  it("returns true for AbortError", () => {
    expect(
      isBackgroundSuppressible(new DOMException("aborted", "AbortError")),
    ).toBe(true);
  });

  it("returns true for NetworkError", () => {
    expect(
      isBackgroundSuppressible(
        new NetworkError("offline", { url: "/", operation: "navigation" }),
      ),
    ).toBe(true);
  });

  it("returns true for TypeError('Failed to fetch')", () => {
    expect(isBackgroundSuppressible(new TypeError("Failed to fetch"))).toBe(
      true,
    );
  });

  it("returns false for a plain Error", () => {
    expect(isBackgroundSuppressible(new Error("boom"))).toBe(false);
  });

  it("returns false for null", () => {
    expect(isBackgroundSuppressible(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isBackgroundSuppressible(undefined)).toBe(false);
  });

  it("returns false for a string", () => {
    expect(isBackgroundSuppressible("error")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// emitNavigationError — routes an unprocessable-response error to the boundary
// ---------------------------------------------------------------------------

describe("emitNavigationError", () => {
  it("renders RenderErrorThrower carrying the error, with isError metadata", () => {
    const onUpdate = vi.fn();
    const err = new Error("undecodable Flight body");

    emitNavigationError(onUpdate, err, "/blog/post-1");

    expect(onUpdate).toHaveBeenCalledOnce();
    const update = onUpdate.mock.calls[0]![0];
    // The thrown error is rendered (not async) so the boundary catches it.
    expect(update.root.type).toBe(RenderErrorThrower);
    expect(update.root.props.error).toBe(err);
    expect(update.metadata).toMatchObject({
      pathname: "/blog/post-1",
      isError: true,
    });
  });

  it("accepts any thrown value, not only Error instances", () => {
    const onUpdate = vi.fn();
    emitNavigationError(onUpdate, "boom", "/x");
    expect(onUpdate.mock.calls[0]![0].root.props.error).toBe("boom");
  });
});
