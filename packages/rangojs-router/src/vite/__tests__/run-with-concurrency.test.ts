import { describe, it, expect } from "vitest";
import { runWithConcurrency } from "../utils/prerender-utils.js";

// E7: on first failure (the default prerender.onError: "fail" re-throws),
// runWithConcurrency must stop scheduling new work so the remaining workers do
// not keep running full RSC renders before the build aborts, and the first
// error must propagate.

describe("runWithConcurrency fail-fast (E7)", () => {
  it("stops starting new tasks after the first error", async () => {
    const total = 50;
    const concurrency = 4;
    const items = Array.from({ length: total }, (_, i) => i);

    let started = 0;
    const failAt = 0; // the first task to actually run throws

    const fn = async (item: number) => {
      started++;
      // Yield so sibling workers get a chance to pull more items if the runner
      // does not abort — that is exactly what the bug would do.
      await Promise.resolve();
      if (item === failAt) {
        throw new Error("boom");
      }
    };

    await expect(runWithConcurrency(items, concurrency, fn)).rejects.toThrow(
      "boom",
    );

    // Without fail-fast, every one of the 50 items would eventually start. With
    // it, only the in-flight batch (bounded by the concurrency limit) runs
    // before scheduling halts. Allow the worst case of one full wave.
    expect(started).toBeLessThanOrEqual(concurrency);
    expect(started).toBeLessThan(total);
  });

  it("surfaces the FIRST error even if a later task also throws", async () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const seen: number[] = [];
    const fn = async (item: number) => {
      seen.push(item);
      await Promise.resolve();
      if (item === 1) throw new Error("first");
      if (item === 2) throw new Error("second");
    };
    await expect(runWithConcurrency(items, 2, fn)).rejects.toThrow("first");
  });

  it("runs every item when none fail", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let done = 0;
    await runWithConcurrency(items, 4, async () => {
      await Promise.resolve();
      done++;
    });
    expect(done).toBe(20);
  });

  it("the serial (concurrency<=1) path also propagates the error and stops", async () => {
    const items = [0, 1, 2, 3, 4];
    let started = 0;
    const fn = async (item: number) => {
      started++;
      if (item === 1) throw new Error("serial-boom");
    };
    await expect(runWithConcurrency(items, 1, fn)).rejects.toThrow(
      "serial-boom",
    );
    // Items 0 and 1 ran; the throw stops the loop before 2..4.
    expect(started).toBe(2);
  });
});
