import { describe, it, expect, vi } from "vitest";
import {
  resolveTimeouts,
  withTimeout,
  isTimeoutEnabled,
  RouterTimeoutError,
  createDefaultTimeoutResponse,
} from "../timeout.js";

describe("resolveTimeouts", () => {
  it("returns all undefined when no options provided", () => {
    const result = resolveTimeouts(undefined, undefined);
    expect(result).toEqual({
      actionMs: undefined,
      renderStartMs: undefined,
      streamIdleMs: undefined,
    });
  });

  it("shorthand applies to actionMs and renderStartMs", () => {
    const result = resolveTimeouts(5000);
    expect(result.actionMs).toBe(5000);
    expect(result.renderStartMs).toBe(5000);
  });

  it("shorthand does NOT apply to streamIdleMs", () => {
    const result = resolveTimeouts(5000);
    expect(result.streamIdleMs).toBeUndefined();
  });

  it("structured values override shorthand", () => {
    const result = resolveTimeouts(5000, {
      actionMs: 3000,
      renderStartMs: 8000,
    });
    expect(result.actionMs).toBe(3000);
    expect(result.renderStartMs).toBe(8000);
  });

  it("structured streamIdleMs is preserved", () => {
    const result = resolveTimeouts(5000, { streamIdleMs: 15000 });
    expect(result.streamIdleMs).toBe(15000);
    // shorthand still applies to the others
    expect(result.actionMs).toBe(5000);
    expect(result.renderStartMs).toBe(5000);
  });

  it("partial structured values merge with shorthand", () => {
    const result = resolveTimeouts(5000, { actionMs: 2000 });
    expect(result.actionMs).toBe(2000);
    // renderStartMs falls back to shorthand
    expect(result.renderStartMs).toBe(5000);
  });

  it("structured-only without shorthand", () => {
    const result = resolveTimeouts(undefined, {
      actionMs: 3000,
      renderStartMs: 8000,
    });
    expect(result.actionMs).toBe(3000);
    expect(result.renderStartMs).toBe(8000);
    expect(result.streamIdleMs).toBeUndefined();
  });
});

describe("isTimeoutEnabled", () => {
  it("is disabled for undefined, 0, and negatives (pass-through)", () => {
    expect(isTimeoutEnabled(undefined)).toBe(false);
    expect(isTimeoutEnabled(0)).toBe(false);
    expect(isTimeoutEnabled(-1)).toBe(false);
  });

  it("is enabled only for positive budgets", () => {
    expect(isTimeoutEnabled(1)).toBe(true);
    expect(isTimeoutEnabled(5000)).toBe(true);
  });
});

describe("RouterTimeoutError", () => {
  it("has correct name", () => {
    const err = new RouterTimeoutError("action", 1234);
    expect(err.name).toBe("RouterTimeoutError");
  });

  it("has correct phase and durationMs", () => {
    const err = new RouterTimeoutError("render-start", 5678.9);
    expect(err.phase).toBe("render-start");
    expect(err.durationMs).toBe(5678.9);
  });

  it("has descriptive message", () => {
    const err = new RouterTimeoutError("action", 1234.5);
    expect(err.message).toBe("Request timed out during action after 1235ms");
  });

  it("is instanceof Error", () => {
    const err = new RouterTimeoutError("action", 100);
    expect(err).toBeInstanceOf(Error);
  });
});

describe("withTimeout", () => {
  it("returns result when operation completes within deadline", async () => {
    const outcome = await withTimeout(Promise.resolve("done"), 1000, "action");
    expect(outcome.timedOut).toBe(false);
    if (!outcome.timedOut) {
      expect(outcome.result).toBe("done");
    }
  });

  it("returns timedOut when operation exceeds deadline", async () => {
    const slow = new Promise<string>((resolve) =>
      setTimeout(() => resolve("late"), 200),
    );
    const outcome = await withTimeout(slow, 10, "action");
    expect(outcome.timedOut).toBe(true);
    if (outcome.timedOut) {
      expect(outcome.durationMs).toBeGreaterThan(0);
    }
  });

  it("passes through when timeoutMs is undefined", async () => {
    const outcome = await withTimeout(
      Promise.resolve("ok"),
      undefined,
      "action",
    );
    expect(outcome.timedOut).toBe(false);
    if (!outcome.timedOut) {
      expect(outcome.result).toBe("ok");
    }
  });

  it("passes through when timeoutMs is 0", async () => {
    const outcome = await withTimeout(Promise.resolve("ok"), 0, "action");
    expect(outcome.timedOut).toBe(false);
    if (!outcome.timedOut) {
      expect(outcome.result).toBe("ok");
    }
  });

  it("passes through when timeoutMs is negative", async () => {
    const outcome = await withTimeout(Promise.resolve("ok"), -1, "action");
    expect(outcome.timedOut).toBe(false);
  });

  it("re-throws non-timeout errors from the operation", async () => {
    const failing = Promise.reject(new Error("boom"));
    await expect(withTimeout(failing, 1000, "action")).rejects.toThrow("boom");
  });

  it("clears timer when operation succeeds before deadline", async () => {
    vi.useFakeTimers();
    try {
      const outcome = await withTimeout(
        Promise.resolve("fast"),
        10000,
        "action",
      );
      expect(outcome.timedOut).toBe(false);
      // Advance past the deadline — should not throw
      vi.advanceTimersByTime(20000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createDefaultTimeoutResponse", () => {
  it("returns 504 status", () => {
    const res = createDefaultTimeoutResponse("action");
    expect(res.status).toBe(504);
  });

  it("has correct body", async () => {
    const res = createDefaultTimeoutResponse("render-start");
    expect(await res.text()).toBe("Request timed out");
  });

  it("sets X-Rango-Timeout-Phase header", () => {
    const res = createDefaultTimeoutResponse("render-start");
    expect(res.headers.get("X-Rango-Timeout-Phase")).toBe("render-start");
  });

  it("sets Content-Type header", () => {
    const res = createDefaultTimeoutResponse("action");
    expect(res.headers.get("Content-Type")).toBe("text/plain;charset=utf-8");
  });
});
