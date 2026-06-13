import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, DEFAULT_DEFER_TIMEOUT_MS, withDefer } from "../defer";

describe("createDeferred", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resolves to the value passed to resolve()", async () => {
    const d = createDeferred<string>();
    d.resolve("hello");
    await expect(d.promise).resolves.toBe("hello");
  });

  it("resolve() is idempotent — the first value wins", async () => {
    const d = createDeferred<string>();
    d.resolve("first");
    d.resolve("second");
    await expect(d.promise).resolves.toBe("first");
  });

  it("auto-resolves to the fallback when resolve() is never called (timeout)", async () => {
    vi.useFakeTimers();
    const d = createDeferred<string>({ timeoutMs: 1000, fallback: "fallback" });
    vi.advanceTimersByTime(1000);
    await expect(d.promise).resolves.toBe("fallback");
  });

  it("warns in dev when the timeout fires", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = createDeferred<string>({ timeoutMs: 500, fallback: "x" });
    vi.advanceTimersByTime(500);
    await d.promise;
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("was not resolved within 500ms"),
    );
  });

  it("resolve() before the timeout cancels it — no fallback, no warn", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = createDeferred<string>({ timeoutMs: 1000, fallback: "fallback" });
    d.resolve("real");
    // Advancing past the timeout must not flip the already-settled value.
    vi.advanceTimersByTime(5000);
    await expect(d.promise).resolves.toBe("real");
    expect(warn).not.toHaveBeenCalled();
  });

  it("timeoutMs: 0 disables the timeout (stays pending until resolve)", async () => {
    vi.useFakeTimers();
    const d = createDeferred<string>({ timeoutMs: 0, fallback: "fallback" });
    let settled = false;
    void d.promise.then(() => {
      settled = true;
    });
    vi.advanceTimersByTime(1_000_000);
    await Promise.resolve();
    expect(settled).toBe(false);
    d.resolve("eventually");
    await expect(d.promise).resolves.toBe("eventually");
  });

  // P2: without a fallback the timeout resolves to undefined, and the promise
  // type reflects that (Deferred<T | null | undefined>, since `else` may be null)
  // — no `as T` lie.
  it("without a fallback the timeout resolves to undefined", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = createDeferred<string>({ timeoutMs: 100 });
    vi.advanceTimersByTime(100);
    const value: string | null | undefined = await d.promise;
    expect(value).toBeUndefined();
  });

  // P3: invalid timeoutMs must NOT silently disable the safety net (a parsed-bad
  // config/env value would otherwise reintroduce the forever-pending hang).
  // NaN and negatives fall back to the default timeout and warn.
  it.each([NaN, -1, -Infinity])(
    "invalid timeoutMs %s falls back to the default timeout (safety net stays on)",
    async (bad) => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const d = createDeferred<string>({ timeoutMs: bad, fallback: "fb" });

      // Not disabled: before the default window nothing has resolved...
      let settled = false;
      void d.promise.then(() => {
        settled = true;
      });
      vi.advanceTimersByTime(DEFAULT_DEFER_TIMEOUT_MS - 1);
      await Promise.resolve();
      expect(settled).toBe(false);

      // ...and at the default window it auto-resolves to the fallback.
      vi.advanceTimersByTime(1);
      await expect(d.promise).resolves.toBe("fb");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("invalid timeout"),
      );
    },
  );
});

// The resolver returned by `.defer()` must be PUSH-EQUAL: it accepts the exact
// argument shapes the push accepts (value, Promise, thunk) and behaves the same.
// The only difference from a direct push is the timeout, which guards solely
// against the resolver never being called — once called, it is a plain push.
describe("withDefer — .defer() resolver is push-equal", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setup<T>() {
    const pushed: unknown[] = [];
    const handle = withDefer<T>((data) => {
      pushed.push(data);
    });
    return { handle, pushed };
  }

  it("reserves the slot synchronously by pushing a pending promise", () => {
    const { handle, pushed } = setup<string>();
    handle.defer();
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toBeInstanceOf(Promise);
  });

  it("resolver settles the reserved slot with a plain value", async () => {
    const { handle, pushed } = setup<string>();
    const resolve = handle.defer();
    resolve("late");
    await expect(pushed[0] as Promise<string>).resolves.toBe("late");
  });

  it("resolver invokes a thunk immediately, like push", async () => {
    const { handle, pushed } = setup<string>();
    const resolve = handle.defer();
    let called = false;
    resolve(() => {
      called = true;
      return Promise.resolve("from-thunk");
    });
    expect(called).toBe(true);
    await expect(pushed[0] as Promise<string>).resolves.toBe("from-thunk");
  });

  it("resolver adopts a Promise argument, like push", async () => {
    const { handle, pushed } = setup<string>();
    const resolve = handle.defer();
    resolve(Promise.resolve("from-promise"));
    await expect(pushed[0] as Promise<string>).resolves.toBe("from-promise");
  });

  it("auto-resolves the slot to `else` when the resolver is never called", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handle, pushed } = setup<string>();
    handle.defer({ timeoutMs: 1000, else: "fallback" });
    vi.advanceTimersByTime(1000);
    await expect(pushed[0] as Promise<string>).resolves.toBe("fallback");
  });

  it("calling the resolver cancels the timeout — a slow Promise is not cut to `else`", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handle, pushed } = setup<string>();
    const resolve = handle.defer({ timeoutMs: 1000, else: "fallback" });

    // The resolver IS called (with a still-pending promise) before the timeout,
    // so the timeout is disarmed even though the value lands later.
    let release!: (value: string) => void;
    resolve(
      new Promise<string>((r) => {
        release = r;
      }),
    );
    vi.advanceTimersByTime(5000); // would have fired the 1000ms timeout if armed
    release("slow-real");

    await expect(pushed[0] as Promise<string>).resolves.toBe("slow-real");
    expect(warn).not.toHaveBeenCalled();
  });

  // Pin the rejection/throw paths: the resolver is push-equal, so a rejecting
  // value behaves exactly like a rejecting direct push (the slot rejects; the
  // consumer's use()/Suspense boundary handles it). The timeout net does NOT
  // turn a rejection into the fallback — a rejection means the resolver WAS
  // called, so the timeout is already disarmed.
  it("adopting a rejecting Promise rejects the reserved slot (push-equal)", async () => {
    const { handle, pushed } = setup<string>();
    const resolve = handle.defer();
    const err = new Error("boom");
    resolve(Promise.reject(err));
    await expect(pushed[0] as Promise<string>).rejects.toBe(err);
  });

  it("a thunk that throws synchronously propagates; the slot is left to the timeout", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handle, pushed } = setup<string>();
    const resolve = handle.defer({ timeoutMs: 1000, else: "fallback" });
    const err = new Error("thunk boom");
    // The thunk runs inside the resolver; throwing propagates to the caller and
    // the slot is never settled by it.
    expect(() =>
      resolve(() => {
        throw err;
      }),
    ).toThrow(err);
    // The slot was not settled, so the safety-net timeout still rescues it.
    vi.advanceTimersByTime(1000);
    await expect(pushed[0] as Promise<string>).resolves.toBe("fallback");
  });
});
