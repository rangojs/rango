import { describe, expect, it, vi } from "vitest";
import { wrapLoaderWithErrorHandling } from "../loader-resolution.js";
import type { EntryData } from "../../server/context";
import type { ErrorBoundaryHandler, ErrorInfo } from "../../types";

// D1: the wrapped-loader promise contract is "never rejects" — segment
// resolution awaits Promise.all(...wrapped), so a single rejection collapses the
// whole entry and discards healthy sibling loader data. When a loader errors AND
// the nearest error-boundary fallback handler throws synchronously while
// rendering, the wrapper must STILL resolve to a LoaderDataResult (falling back
// to the no-boundary shape, fallback: null, so the client throws the original
// error) instead of letting the fallback throw reject the wrapped promise.

function makeEntry(): EntryData {
  return {
    id: "route0",
    shortCode: "R0",
    type: "route",
  } as unknown as EntryData;
}

function createErrorInfo(
  error: unknown,
  segmentId: string,
  segmentType: ErrorInfo["segmentType"],
): ErrorInfo {
  return {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : "Error",
    segmentId,
    segmentType,
  };
}

describe("wrapLoaderWithErrorHandling — error-boundary fallback render throw (D1)", () => {
  it("resolves (does not reject) and yields the no-boundary result when the fallback handler throws", async () => {
    const loaderError = new Error("loader boom");
    // A user ErrorBoundaryHandler that throws synchronously while rendering.
    const throwingFallback: ErrorBoundaryHandler = () => {
      throw new Error("fallback render boom");
    };

    const wrapped = wrapLoaderWithErrorHandling(
      Promise.reject(loaderError),
      makeEntry(),
      "R0.loaderA",
      "/test",
      () => throwingFallback,
      createErrorInfo,
    );

    // Contract: never rejects. If the fix is absent this rejects with the
    // fallback's throw and the assertion below would never run (the await throws).
    const result = await wrapped;

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected an error result");
    // Falls back to the no-boundary shape so the client throws the ORIGINAL error.
    expect(result.fallback).toBeNull();
    expect(result.error.message).toBe("loader boom");
  });

  it("still renders a healthy fallback when the handler does not throw", async () => {
    const fallback = vi.fn((): string => "rendered fallback");

    const wrapped = wrapLoaderWithErrorHandling(
      Promise.reject(new Error("loader boom")),
      makeEntry(),
      "R0.loaderA",
      "/test",
      () => fallback as unknown as ErrorBoundaryHandler,
      createErrorInfo,
    );

    const result = await wrapped;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected an error result");
    expect(result.fallback).toBe("rendered fallback");
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});
