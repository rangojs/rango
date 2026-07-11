import { describe, it, expect } from "vitest";
import {
  CaptureQueueFullError,
  enqueueSerializedCapture,
  MAX_ADMITTED_CAPTURES,
} from "../capture-queue.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("enqueueSerializedCapture", () => {
  it("never runs two captures concurrently and preserves enqueue order", async () => {
    const events: string[] = [];
    let running = 0;
    let maxConcurrent = 0;

    const capture = (name: string, ticks: number) => async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      events.push(`start:${name}`);
      for (let i = 0; i < ticks; i++) await tick();
      events.push(`end:${name}`);
      running--;
    };

    await Promise.all([
      enqueueSerializedCapture(capture("grinding", 5)),
      enqueueSerializedCapture(capture("victim", 1)),
      enqueueSerializedCapture(capture("third", 1)),
    ]);

    expect(maxConcurrent).toBe(1);
    expect(events).toEqual([
      "start:grinding",
      "end:grinding",
      "start:victim",
      "end:victim",
      "start:third",
      "end:third",
    ]);
  });

  it("a rejected capture propagates to its caller but never wedges the queue", async () => {
    const events: string[] = [];

    const failing = enqueueSerializedCapture(async () => {
      events.push("failing");
      throw new Error("capture boom");
    });
    const after = enqueueSerializedCapture(async () => {
      events.push("after");
    });

    await expect(failing).rejects.toThrow("capture boom");
    await after;
    expect(events).toEqual(["failing", "after"]);
  });

  it("returns each task's own completion (not the queue's)", async () => {
    const order: number[] = [];
    const first = enqueueSerializedCapture(async () => {
      await tick();
      order.push(1);
    });
    const second = enqueueSerializedCapture(async () => {
      order.push(2);
    });
    await first;
    // First's promise settles as soon as ITS task ends, independent of second.
    expect(order).toEqual([1]);
    await second;
    expect(order).toEqual([1, 2]);
  });

  it("rejects work beyond the per-isolate admission bound and recovers after drain", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const admitted = Array.from({ length: MAX_ADMITTED_CAPTURES }, () =>
      enqueueSerializedCapture(() => blocked),
    );

    await expect(
      enqueueSerializedCapture(async () => {}),
    ).rejects.toBeInstanceOf(CaptureQueueFullError);

    release();
    await Promise.all(admitted);
    await expect(
      enqueueSerializedCapture(async () => {}),
    ).resolves.toBeUndefined();
  });
});
