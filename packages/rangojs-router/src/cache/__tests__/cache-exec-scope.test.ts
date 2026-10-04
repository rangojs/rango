/**
 * Unit tests for the "use cache" execution-chain scope (cache-exec-scope.ts)
 * and its probe wiring into assertNotInsideCacheExec (taint.ts).
 *
 * The probe covers AMBIENT ctx access inside a cached body — a ctx method
 * reached via getRequestContext() rather than an argument. Before the probe,
 * that coverage came from stamping INSIDE_CACHE_EXEC on the shared
 * RequestContext, which also poisoned every PARALLEL chain on the request.
 */

import { describe, it, expect } from "vitest";
import {
  runWithCacheExecScope,
  isInsideCacheExecScope,
} from "../cache-exec-scope.js";
import {
  assertNotInsideCacheExec,
  stampCacheExec,
  unstampCacheExec,
} from "../taint.js";

describe("cache exec scope", () => {
  it("is active only within the wrapped chain, including across awaits", async () => {
    expect(isInsideCacheExecScope()).toBe(false);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const inside = runWithCacheExecScope(async () => {
      expect(isInsideCacheExecScope()).toBe(true);
      await gate;
      return isInsideCacheExecScope();
    });

    // Parallel chain while the scoped body is suspended: not inside.
    expect(isInsideCacheExecScope()).toBe(false);

    release();
    await expect(inside).resolves.toBe(true);
    expect(isInsideCacheExecScope()).toBe(false);
  });

  it("assertNotInsideCacheExec throws inside the scope for un-stamped ctx (ambient access)", () => {
    const plainCtx = {};
    expect(() => assertNotInsideCacheExec(plainCtx, "set")).not.toThrow();
    runWithCacheExecScope(() => {
      expect(() => assertNotInsideCacheExec(plainCtx, "set")).toThrow(
        /cannot be called inside a "use cache" function/,
      );
    });
  });

  it("assertNotInsideCacheExec still honors the per-object arg stamp outside the scope", () => {
    const ctx = {};
    stampCacheExec(ctx);
    try {
      expect(() => assertNotInsideCacheExec(ctx, "header")).toThrow(
        /cannot be called inside a "use cache" function/,
      );
      expect(() => assertNotInsideCacheExec({}, "header")).not.toThrow();
    } finally {
      unstampCacheExec(ctx);
    }
    expect(() => assertNotInsideCacheExec(ctx, "header")).not.toThrow();
  });
});
