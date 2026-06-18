import { describe, it, expect, vi } from "vitest";
import { createHandleStore } from "../handle-store";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("HandleStore settlement", () => {
  it("settled resolves immediately when sealed with nothing tracked", async () => {
    const store = createHandleStore();
    store.seal();
    await store.settled; // should not hang
  });

  it("settled waits for seal when nothing is tracked", async () => {
    const store = createHandleStore();
    let resolved = false;

    store.settled.then(() => {
      resolved = true;
    });

    // Give a microtick — settled should NOT resolve without seal
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    store.seal();
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  it("settled waits for seal + drain", async () => {
    const store = createHandleStore();
    let resolved = false;

    store.track(
      delay(20).then(() => {
        resolved = true;
      }),
    );

    store.seal();

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
        store.track(
          delay(20).then(() => {
            order.push("second");
          }),
        );
      }),
    );

    store.seal();
    await store.settled;
    expect(order).toEqual(["first", "second"]);
  });

  it("multiple settled readers all wait for seal + drain", async () => {
    const store = createHandleStore();
    let done = false;

    store.track(
      delay(20).then(() => {
        done = true;
      }),
    );
    store.seal();

    const results = await Promise.all([store.settled, store.settled]);

    expect(results).toEqual([undefined, undefined]);
    expect(done).toBe(true);
  });

  it("stream does not complete before tracks settle", async () => {
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

  it("stream auto-seals: completes immediately when no tracks registered", async () => {
    const store = createHandleStore();
    const yields: unknown[] = [];

    // stream() auto-seals. With no tracks, it completes immediately.
    for await (const snapshot of store.stream()) {
      yields.push(snapshot);
    }

    expect(yields).toEqual([]);
  });

  it("direct settled blocks until explicit seal (prevents reader-before-track race)", async () => {
    const store = createHandleStore();
    let settled = false;

    // Read settled BEFORE any tracks or seal — should block
    store.settled.then(() => {
      settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    // Register a track
    store.track(
      delay(10).then(() => {
        store.push("meta", "seg1", "value");
      }),
    );

    // Still not settled — seal not called yet
    await Promise.resolve();
    expect(settled).toBe(false);

    // Seal, then wait for drain
    store.seal();
    await delay(20);
    expect(settled).toBe(true);
  });

  it("coalesces a synchronous burst of pushes into the full accumulated state", async () => {
    const store = createHandleStore();

    // 50 synchronous pushes across 3 handles / 3 segments.
    const handles = ["crumbs", "meta", "links"];
    const segments = ["seg1", "seg2", "seg3"];
    let pushCount = 0;
    store.track(
      delay(5).then(() => {
        for (let i = 0; i < 50; i++) {
          const handle = handles[i % handles.length];
          const segment = segments[i % segments.length];
          store.push(handle, segment, `value-${i}`);
          pushCount++;
        }
      }),
    );

    const yields: Record<string, Record<string, unknown[]>>[] = [];
    for await (const snapshot of store.stream()) {
      yields.push(snapshot as Record<string, Record<string, unknown[]>>);
    }

    expect(pushCount).toBe(50);

    // The final snapshot must contain ALL pushed entries (full accumulated state).
    const final = yields[yields.length - 1];
    let total = 0;
    for (const handle of handles) {
      for (const segment of segments) {
        total += final[handle]?.[segment]?.length ?? 0;
      }
    }
    expect(total).toBe(50);

    // The burst coalesces: far fewer yields than the 50 pushes.
    expect(yields.length).toBeLessThanOrEqual(3);
  });

  it("getData auto-seals and waits for all tracked promises", async () => {
    const store = createHandleStore();

    store.track(
      delay(10).then(() => {
        store.push("meta", "seg1", { title: "Hello" });
      }),
    );

    const data = await store.getData();
    expect(data).toEqual({ meta: { seg1: [{ title: "Hello" }] } });
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

  it("onError callback fires before LateHandlePushError is thrown", async () => {
    const store = createHandleStore();
    const errors: Error[] = [];
    store.onError = (error) => errors.push(error);

    // Drain the stream to set completed = true
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of store.stream()) {
      // no-op
    }

    expect(() => store.push("meta", "seg1", "late")).toThrow(
      /pushed after handle collection completed/,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].name).toBe("LateHandlePushError");
  });

  it("onError is not called for normal push operations", () => {
    const store = createHandleStore();
    const onError = vi.fn();
    store.onError = onError;

    store.push("meta", "seg1", "value");
    expect(onError).not.toHaveBeenCalled();
  });

  it("seal is idempotent", () => {
    const store = createHandleStore();
    store.seal();
    store.seal(); // should not throw
  });

  // The cache codec (handle-snapshot.ts encodeHandles) relies on the store
  // handing back handle VALUES untouched so Flight can serialize them. If the
  // store ever mangled non-scalar values (e.g. coerced through JSON), the cache
  // would silently corrupt Promise/ReactNode handles before the codec ran.
  describe("non-scalar handle values pass through by reference", () => {
    it("getDataForSegment preserves a Promise and a ReactNode value by reference", () => {
      const store = createHandleStore();
      const promiseValue = Promise.resolve("late");
      promiseValue.catch(() => {});
      // A minimal React element shape (the kind Breadcrumbs `content` produces).
      const elementValue = { $$typeof: Symbol.for("react.element"), type: "b" };

      store.push("crumbs", "seg1", promiseValue);
      store.push("crumbs", "seg1", elementValue);

      const data = store.getDataForSegment("seg1");
      // Same references, not coerced/cloned — the codec receives them intact.
      expect(data.crumbs[0]).toBe(promiseValue);
      expect(data.crumbs[1]).toBe(elementValue);
    });

    it("replaySegmentData restores values by reference", () => {
      const store = createHandleStore();
      const promiseValue = Promise.resolve("restored");
      promiseValue.catch(() => {});

      store.replaySegmentData("seg1", { crumbs: [promiseValue] });

      expect(store.getDataForSegment("seg1").crumbs[0]).toBe(promiseValue);
    });
  });
});
