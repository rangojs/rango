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

  // D3: the producer (loader-resolution.ts) uses `fallback: null` as the ONLY
  // no-boundary sentinel; a matched boundary's rendered ReactNode can be falsy
  // (0, "", false). decodeLoaderResults must treat those as a real fallback
  // (test for != null), not discard them and rethrow the original loader error.
  describe("falsy-but-present error boundary fallbacks (D3)", () => {
    for (const falsy of [0, "", false] as const) {
      it(`uses a fallback of ${JSON.stringify(falsy)} instead of rethrowing`, () => {
        // Producer signals a matched boundary by setting fallback to the
        // rendered node — here a legitimately falsy value.
        const result: LoaderDataResult = {
          __loaderResult: true,
          ok: false,
          error: { message: "boom" } as any,
          fallback: falsy as any,
        };

        let thrown: unknown;
        let out: ReturnType<typeof decodeLoaderResults> | undefined;
        try {
          out = decodeLoaderResults([result], ["a"]);
        } catch (e) {
          thrown = e;
        }

        // The original loader error must NOT escape.
        expect(thrown).toBeUndefined();
        // The falsy node is the chosen errorFallback.
        expect(out!.errorFallback).toBe(falsy);
      });
    }

    it("still rethrows when fallback is null (the genuine no-boundary case)", () => {
      const result: LoaderDataResult = {
        __loaderResult: true,
        ok: false,
        error: { message: "no-boundary boom" } as any,
        fallback: null,
      };
      expect(() => decodeLoaderResults([result], ["a"])).toThrow(
        "no-boundary boom",
      );
    });
  });
});

// --- Loader-thrown authority signals (notFound()/redirect()) ---

import {
  decodeLoaderEntry,
  LOADER_NOT_FOUND_FALLBACK,
  LOADER_REDIRECT,
} from "../decode-loader-results.js";
import { LoaderRedirect } from "../loader-redirect.js";
import { isValidElement } from "react";

const notFoundResult = (fallback: unknown): LoaderDataResult => ({
  __loaderResult: true,
  ok: false,
  notFound: true,
  error: { message: "Product not found", name: "DataNotFoundError" } as any,
  fallback: fallback as any,
});

const redirectResult = (to: string): LoaderDataResult => ({
  __loaderResult: true,
  ok: false,
  redirect: { to },
  error: { message: `Loader redirected to ${to}` } as any,
  fallback: null,
});

describe("decodeLoaderEntry signals (read-site throw path)", () => {
  it("throws with LOADER_NOT_FOUND_FALLBACK carrying the server-rendered node", () => {
    let thrown: unknown;
    try {
      decodeLoaderEntry(notFoundResult("not-found-ui"));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("DataNotFoundError");
    expect((thrown as any)[LOADER_NOT_FOUND_FALLBACK]).toBe("not-found-ui");
  });

  it("notFound with a null fallback still carries the marker (renders empty, not error)", () => {
    let thrown: unknown;
    try {
      decodeLoaderEntry(notFoundResult(null));
    } catch (e) {
      thrown = e;
    }
    expect(LOADER_NOT_FOUND_FALLBACK in (thrown as object)).toBe(true);
    expect((thrown as any)[LOADER_NOT_FOUND_FALLBACK]).toBeNull();
  });

  it("throws with LOADER_REDIRECT carrying the resolved target", () => {
    let thrown: unknown;
    try {
      decodeLoaderEntry(redirectResult("/new-home"));
    } catch (e) {
      thrown = e;
    }
    expect((thrown as any)[LOADER_REDIRECT]).toEqual({ to: "/new-home" });
  });
});

describe("decodeLoaderResults signals (aggregate non-throw path)", () => {
  it("notFound takes the errorFallback slot without throwing (runs during server tree build)", () => {
    const { errorFallback } = decodeLoaderResults(
      [ok("healthy"), notFoundResult("not-found-ui")],
      ["a", "b"],
    );
    expect(errorFallback).toBe("not-found-ui");
  });

  it("a signal outranks a later plain error fallback (scan stops at the signal)", () => {
    const { errorFallback } = decodeLoaderResults(
      [notFoundResult("not-found-ui"), fail("boom", "error-ui")],
      ["a", "b"],
    );
    expect(errorFallback).toBe("not-found-ui");
  });

  it("redirect plants a LoaderRedirect element in the errorFallback slot", () => {
    const { errorFallback } = decodeLoaderResults(
      [redirectResult("/moved")],
      ["a"],
    );
    expect(isValidElement(errorFallback)).toBe(true);
    expect((errorFallback as any).type).toBe(LoaderRedirect);
    expect((errorFallback as any).props.to).toBe("/moved");
  });
});
