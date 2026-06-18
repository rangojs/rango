import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createErrorInfo } from "../error-handling.js";

// createErrorInfo forwards error.cause onto ErrorInfo in dev. ErrorInfo.cause
// crosses the RSC Flight boundary (via LoaderDataResult.error and error-segment
// fallback props), so a non-serializable cause (function, class instance,
// circular object) would make Flight serialization itself throw and mask the
// original loader error. createErrorInfo must normalize cause into a
// serializable shape. createErrorInfo reads process.env.NODE_ENV at call time,
// so these run on the dev branch (NODE_ENV !== "production").
describe("createErrorInfo cause normalization (dev)", () => {
  const prev = process.env.NODE_ENV;
  beforeAll(() => {
    process.env.NODE_ENV = "development";
  });
  afterAll(() => {
    process.env.NODE_ENV = prev;
  });

  it("stringifies a function cause into a serializable value", () => {
    const error = new Error("boom");
    (error as { cause?: unknown }).cause = function someCause() {};

    const info = createErrorInfo(error, "seg", "loader");

    expect(typeof info.cause).toBe("string");
    // Survives both Flight-equivalent serialization paths.
    expect(() => JSON.stringify(info)).not.toThrow();
    expect(() => structuredClone(info)).not.toThrow();
  });

  it("flattens a nested Error cause into {name, message, stack}", () => {
    const inner = new Error("inner failure");
    inner.name = "InnerError";
    const error = new Error("outer");
    (error as { cause?: unknown }).cause = inner;

    const info = createErrorInfo(error, "seg", "loader");

    expect(info.cause).toEqual({
      name: "InnerError",
      message: "inner failure",
      stack: inner.stack,
    });
    expect(() => JSON.stringify(info)).not.toThrow();
    expect(() => structuredClone(info)).not.toThrow();
  });

  it("preserves a plain serializable object cause intact (does not flatten to a string)", () => {
    const error = new Error("http");
    (error as { cause?: unknown }).cause = { httpStatus: 503, retryable: true };

    const info = createErrorInfo(error, "seg", "loader");

    // Common, Flight-safe cause shape must survive as structured data, not
    // collapse to "[object Object]".
    expect(info.cause).toEqual({ httpStatus: 503, retryable: true });
    expect(() => structuredClone(info)).not.toThrow();
  });

  it("preserves a circular object cause as a structured-clone-safe graph", () => {
    const circular: Record<string, unknown> = { tag: "cyclic" };
    circular.self = circular;
    const error = new Error("cyclic");
    (error as { cause?: unknown }).cause = circular;

    const info = createErrorInfo(error, "seg", "loader");

    // structuredClone preserves cycles (so does Flight), so the cause stays a
    // graph rather than collapsing to "[object Object]"; it must remain
    // structured-clone-safe (the Flight-equivalent contract).
    expect(typeof info.cause).toBe("object");
    expect((info.cause as { tag?: string }).tag).toBe("cyclic");
    expect(() => structuredClone(info)).not.toThrow();
  });

  it("falls back to a string when cause is a non-cloneable object", () => {
    // A function property makes structuredClone throw (DataCloneError); the
    // catch path stringifies so the ErrorInfo stays serializable.
    const error = new Error("non-cloneable");
    (error as { cause?: unknown }).cause = { onRetry: () => {} };

    const info = createErrorInfo(error, "seg", "loader");

    expect(typeof info.cause).toBe("string");
    expect(() => structuredClone(info)).not.toThrow();
  });

  it("never throws even when reading the cause runs throwing user code (Proxy trap)", () => {
    // A Proxy whose getPrototypeOf trap throws makes `cause instanceof Error`
    // throw; normalizeCause must catch it rather than mask the loader error.
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("proto-boom");
        },
      },
    );
    const error = new Error("hostile cause");
    (error as { cause?: unknown }).cause = hostile;

    let info: ReturnType<typeof createErrorInfo>;
    expect(() => {
      info = createErrorInfo(error, "seg", "loader");
    }).not.toThrow();
    expect(() => structuredClone(info!)).not.toThrow();
  });

  it("leaves a nullish cause undefined", () => {
    const error = new Error("no cause");
    const info = createErrorInfo(error, "seg", "loader");
    expect(info.cause).toBeUndefined();
  });
});
