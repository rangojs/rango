import { describe, it, expect } from "vitest";
import { decodeLoaderResults } from "../decode-loader-results.js";
import type { LoaderDataResult } from "../types.js";

const ok = (data: unknown): LoaderDataResult => ({
  __loaderResult: true,
  ok: true,
  data,
});

const fail = (message: string, fallback: unknown): LoaderDataResult => ({
  __loaderResult: true,
  ok: false,
  error: { message } as any,
  fallback: fallback as any,
});

describe("decodeLoaderResults", () => {
  it("unwraps ok results and passes legacy non-result values through by id", () => {
    // A loader resolved before the result-wrapping convention yields a raw
    // value; it must be keyed by id unchanged alongside an unwrapped ok result.
    const { loaderData, errorFallback } = decodeLoaderResults(
      [ok({ count: 1 }), "legacy-raw"],
      ["wrapped", "legacy"],
    );

    expect(loaderData).toEqual({
      wrapped: { count: 1 },
      legacy: "legacy-raw",
    });
    expect(errorFallback).toBeNull();
  });

  it("keeps the last failing loader's fallback when several fail with fallbacks", () => {
    const { loaderData, errorFallback } = decodeLoaderResults(
      [
        fail("first failed", "fallbackA"),
        ok("good"),
        fail("second failed", "fallbackB"),
      ],
      ["a", "b", "c"],
    );

    // Last failing loader wins the single errorFallback slot.
    expect(errorFallback).toBe("fallbackB");
    // Data captured before the failures survives.
    expect(loaderData).toEqual({ b: "good" });
  });

  it("throws with the failing loader's message when a failure has no fallback", () => {
    // Discards the earlier captured fallback and any accumulated data — the
    // deliberate fail-fast behavior for an unrecoverable loader error.
    expect(() =>
      decodeLoaderResults(
        [
          fail("recoverable", "fallbackA"),
          fail("fatal", null),
          ok("never-read"),
        ],
        ["a", "b", "c"],
      ),
    ).toThrow("fatal");
  });

  it("preserves the ErrorInfo identity (name/stack/code/cause) when rethrowing without a fallback", () => {
    // Worst-case path: a loader fails with no boundary. The rethrown error must
    // carry the ErrorInfo's name/stack/code/cause, not a stripped generic Error.
    const cause = {
      name: "Error",
      message: "root cause",
      stack: "cause-stack",
    };
    const result: LoaderDataResult = {
      __loaderResult: true,
      ok: false,
      error: {
        message: "custom failure",
        name: "CustomError",
        code: "E_X",
        stack: "CustomError: custom failure\n    at loader",
        cause,
        segmentId: "seg",
        segmentType: "loader",
      },
      fallback: null,
    } as any;

    let thrown: unknown;
    try {
      decodeLoaderResults([result], ["a"]);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Error);
    const err = thrown as Error & { code?: string };
    expect(err.message).toBe("custom failure");
    expect(err.name).toBe("CustomError");
    expect(err.stack).toBe("CustomError: custom failure\n    at loader");
    expect(err.code).toBe("E_X");
    expect(err.cause).toEqual(cause);
  });

  it("returns an empty result set for no loaders", () => {
    expect(decodeLoaderResults([], [])).toEqual({
      loaderData: {},
      errorFallback: null,
    });
  });
});
