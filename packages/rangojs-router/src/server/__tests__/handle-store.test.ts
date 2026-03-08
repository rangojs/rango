import { describe, it, expect } from "vitest";
import { createHandleStore } from "../handle-store";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("HandleStore settlement", () => {
  it("settled resolves immediately when nothing is tracked", async () => {
    const store = createHandleStore();
    await store.settled; // should not hang
  });

  it("settled waits for a single tracked promise", async () => {
    const store = createHandleStore();
    let resolved = false;

    store.track(
      delay(20).then(() => {
        resolved = true;
      }),
    );

    expect(resolved).toBe(false);
    await store.settled;
    expect(resolved).toBe(true);
  });

  it("settled waits for late track() calls added while earlier ones are in flight", async () => {
    const store = createHandleStore();
    const order: string[] = [];

    // First track resolves quickly and registers a second track
    store.track(
      delay(10).then(() => {
        order.push("first");
        // Late track: added after settled was already read
        store.track(
          delay(20).then(() => {
            order.push("second");
          }),
        );
      }),
    );

    // Read settled before the late track is registered
    await store.settled;
    expect(order).toEqual(["first", "second"]);
  });

  it("multiple settled readers all wait for drain", async () => {
    const store = createHandleStore();
    let done = false;

    store.track(
      delay(20).then(() => {
        done = true;
      }),
    );

    const results = await Promise.all([store.settled, store.settled]);

    expect(results).toEqual([undefined, undefined]);
    expect(done).toBe(true);
  });

  it("getData waits for all tracked promises before returning", async () => {
    const store = createHandleStore();

    store.track(
      delay(10).then(() => {
        store.push("meta", "seg1", { title: "Hello" });
      }),
    );

    const data = await store.getData();
    expect(data).toEqual({ meta: { seg1: [{ title: "Hello" }] } });
  });

  it("stream completes only after all tracked promises settle", async () => {
    const store = createHandleStore();

    store.track(
      delay(10).then(() => {
        store.push("breadcrumbs", "seg1", "crumb1");
      }),
    );

    const yields: unknown[] = [];
    for await (const snapshot of store.stream()) {
      yields.push(snapshot);
    }

    expect(yields.length).toBeGreaterThanOrEqual(1);
    const last = yields[yields.length - 1] as Record<
      string,
      Record<string, unknown[]>
    >;
    expect(last.breadcrumbs.seg1).toEqual(["crumb1"]);
  });

  it("push after completion throws LateHandlePushError", async () => {
    const store = createHandleStore();

    // Drain the stream to set completed = true
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of store.stream()) {
      // no-op
    }

    expect(() => store.push("meta", "seg1", "late")).toThrow(
      /pushed after handle collection completed/,
    );
  });
});
