/**
 * reportCacheError prints a cache failure with its label. A render error the
 * cache refuses to store (the document cache, a PPR capture) was printed
 * where it originated, so the cache reports it to onError without printing it
 * again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportCacheError } from "../cache-error.js";
import { printServerError } from "../../server/print-server-error.js";
import { runWithRequestContext } from "../../server/request-context.js";
import { makeRequestContext } from "../../__tests__/kit/request-context.js";

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reportCacheError: printing", () => {
  it("prints a cache failure with its label", () => {
    const ctx = makeRequestContext({ url: "https://shop.example/product/1" });
    ctx._reportBackgroundError = vi.fn();
    const error = new Error("KV put failed");

    runWithRequestContext(ctx, () =>
      reportCacheError(error, "cache-write", "[DocumentCache] cache write"),
    );

    expect(consoleError.mock.calls).toEqual([
      ["[DocumentCache] cache write:", error],
    ]);
    expect(ctx._reportBackgroundError).toHaveBeenCalledWith(
      error,
      "cache-write",
    );
  });

  it("reports a render error printed where it originated without printing it again", () => {
    const ctx = makeRequestContext({ url: "https://shop.example/product/1" });
    ctx._reportBackgroundError = vi.fn();
    const error = new Error("reviews widget failed");

    runWithRequestContext(ctx, () => {
      printServerError(error, { label: "Rendering error" }, ctx);
      reportCacheError(error, "cache-write", "[DocumentCache] cache write");
    });

    expect(consoleError.mock.calls).toEqual([
      ["[RSC] Rendering error:", error],
    ]);
    expect(ctx._reportBackgroundError).toHaveBeenCalledWith(
      error,
      "cache-write",
    );
  });
});
