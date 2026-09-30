import { describe, it, expect, vi } from "vitest";
import { createHandleStore } from "../handle-store";
import { createElement } from "react";
import { runInsideLoaderBodyScope, runInsideLoaderScope } from "../context.js";
import {
  holdsThenable,
  maskNestedContainerThenables,
} from "../../router/segment-resolution/mask-nested.js";

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

describe("HandleStore two-lane settlement (loader handle writes)", () => {
  it("auxiliary tracking does not block `settled` (handler barrier)", async () => {
    const store = createHandleStore();
    let releaseLoader!: () => void;
    store.trackAuxiliary(new Promise<void>((r) => (releaseLoader = r)));
    store.seal();
    // settled resolves with the aux lane still in flight.
    await store.settled;
    releaseLoader();
    await store.fullySettled;
  });

  it("a push AFTER settled but BEFORE fullySettled is legal and reaches the default stream", async () => {
    const store = createHandleStore();
    let releaseLoader!: () => void;
    const loaderBody = new Promise<void>((r) => (releaseLoader = r));
    store.trackAuxiliary(
      loaderBody.then(() => {
        store.push("meta", "seg1", { title: "late" });
      }),
    );

    const yields: unknown[] = [];
    const consume = (async () => {
      for await (const d of store.stream()) yields.push(d);
    })();

    await store.settled;
    releaseLoader();
    await consume;

    expect(yields.at(-1)).toEqual({ meta: { seg1: [{ title: "late" }] } });
  });

  it('stream("settled") completes at the handler barrier while the aux lane is pending', async () => {
    const store = createHandleStore();
    store.push("meta", "seg1", "early");
    let releaseLoader!: () => void;
    store.trackAuxiliary(new Promise<void>((r) => (releaseLoader = r)));

    const yields: unknown[] = [];
    for await (const d of store.stream("settled")) yields.push(d);
    // Completed without waiting for the loader; early push included.
    expect(yields.at(-1)).toEqual({ meta: { seg1: ["early"] } });

    // The aux lane is still open: a loader push now must NOT throw.
    expect(() => store.push("meta", "seg1", "late")).not.toThrow();
    releaseLoader();
    await store.fullySettled;
  });

  it("streamLate yields only post-settle pushes and completes at fullySettled", async () => {
    const store = createHandleStore();
    store.push("meta", "seg1", "early");
    let releaseLoader!: () => void;
    store.trackAuxiliary(
      new Promise<void>((r) => (releaseLoader = r)).then(() => {
        store.push("crumbs", "seg2", "late-crumb");
      }),
    );

    const lateYields: any[] = [];
    const consume = (async () => {
      for await (const d of store.streamLate()) lateYields.push(d);
    })();

    await store.settled;
    releaseLoader();
    await consume;

    expect(lateYields).toHaveLength(1);
    // Full-state yield: includes the early push too (cumulative snapshot).
    expect(lateYields[0].crumbs).toEqual({ seg2: ["late-crumb"] });
  });

  it("streamLate returns without yielding when the aux lane is empty at settled", async () => {
    const store = createHandleStore();
    store.push("meta", "seg1", "early");
    const lateYields: unknown[] = [];
    for await (const d of store.streamLate()) lateYields.push(d);
    expect(lateYields).toHaveLength(0);
  });
});

describe("HandleStore loader-push tagging (cache() record exclusion)", () => {
  it("getDataForSegment(id, true) drops DSL-loader pushes by position, primitives included", () => {
    const store = createHandleStore();
    store.push("crumbs", "seg1", { label: "handler-a" });
    runInsideLoaderScope(() => {
      store.push("crumbs", "seg1", { label: "loader" });
      store.push("crumbs", "seg1", "loader-string");
      // A handle with only loader pushes is omitted entirely.
      store.push("meta", "seg1", { title: "t" });
    });
    store.push("crumbs", "seg1", "handler-b");

    expect(store.getDataForSegment("seg1", true)).toEqual({
      crumbs: [{ label: "handler-a" }, "handler-b"],
    });
    // Default read (render snapshot, prerender) sees every push.
    expect(store.getDataForSegment("seg1").crumbs).toHaveLength(4);
  });

  it("push's loaderPush argument overrides the loader-scope tag", () => {
    const store = createHandleStore();
    runInsideLoaderScope(() => {
      store.push("crumbs", "seg1", "untagged-in-scope", false);
      store.push("crumbs", "seg1", "tagged-in-scope");
    });
    store.push("crumbs", "seg1", "tagged-out-of-scope", true);

    expect(store.getDataForSegment("seg1", true)).toEqual({
      crumbs: ["untagged-in-scope"],
    });
  });

  it("getRecordOwners reports push owners aligned with getDataForSegment(id, true)", () => {
    const store = createHandleStore();
    store.push("crumbs", "seg1", "handler");
    runInsideLoaderScope(() => {
      store.push("crumbs", "seg1", "excluded");
      store.push("crumbs", "seg1", "baked", false, "L");
    });
    store.push("meta", "seg1", "handler-only");

    expect(store.getDataForSegment("seg1", true)).toEqual({
      crumbs: ["handler", "baked"],
      meta: ["handler-only"],
    });
    expect(store.getRecordOwners("seg1")).toEqual({ crumbs: [null, "L"] });
    expect(store.getRecordOwners("seg2")).toBeUndefined();
  });

  it("replayed values are untagged; a later loader push is tagged", () => {
    const store = createHandleStore();
    runInsideLoaderScope(() => store.push("crumbs", "seg1", "stale-loader"));
    store.replaySegmentData("seg1", { crumbs: ["recorded"] });
    runInsideLoaderScope(() => store.push("crumbs", "seg1", "live-loader"));

    expect(store.getDataForSegment("seg1", true)).toEqual({
      crumbs: ["recorded"],
    });
  });
});

describe("HandleStore.pushReplayed (loader-cache HIT replay)", () => {
  // A live push by loader `id` runs inside its body scope, as the loader
  // executor does (runInsideLoaderBodyScope); DSL loaders add the loader scope.
  const livePush = (
    store: ReturnType<typeof createHandleStore>,
    id: string,
    segmentId: string,
    value: unknown,
  ) =>
    runInsideLoaderScope(() =>
      runInsideLoaderBodyScope(
        () => store.push("crumbs", segmentId, value),
        id,
      ),
    );

  it("the loader's first live push takes the replayed slot's position; later live pushes follow it", () => {
    const store = createHandleStore();
    store.push("crumbs", "seg1", "handler");
    runInsideLoaderScope(() => {
      store.pushReplayed("crumbs", "seg1", "dep-cached", "Dep");
      store.pushReplayed("crumbs", "seg1", "own-cached", "Own");
    });
    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "handler",
      "dep-cached",
      "own-cached",
    ]);

    livePush(store, "Dep", "seg1", "dep-live-1");
    livePush(store, "Other", "seg1", "other-live");
    livePush(store, "Dep", "seg1", "dep-live-2");

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "handler",
      "dep-live-1",
      "dep-live-2",
      "own-cached",
      "other-live",
    ]);
    // Loader tagging follows the moved positions: only the handler push is
    // kept for a cache() record.
    expect(store.getDataForSegment("seg1", true)).toEqual({
      crumbs: ["handler"],
    });
  });

  it("a live push to another segment removes the replayed slots and lands where it is pushed", () => {
    const store = createHandleStore();
    store.pushReplayed("crumbs", "seg1", "dep-cached", "Dep");
    store.pushReplayed("crumbs", "seg1", "own-cached", "Own");

    livePush(store, "Dep", "seg2", "dep-live");

    expect(store.getDataForSegment("seg1").crumbs).toEqual(["own-cached"]);
    expect(store.getDataForSegment("seg2").crumbs).toEqual(["dep-live"]);
  });

  it("a push outside the replayed loader's body does not touch its replayed slots", () => {
    const store = createHandleStore();
    store.pushReplayed("crumbs", "seg1", "dep-cached", "Dep");
    store.push("crumbs", "seg1", "handler");
    livePush(store, "Other", "seg1", "other-live");

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "dep-cached",
      "handler",
      "other-live",
    ]);
  });

  it("the replacement reaches stream consumers as a full per-segment snapshot", async () => {
    const store = createHandleStore();
    // The live loader body holds the auxiliary lane open, as the executor does.
    let release!: () => void;
    store.trackAuxiliary(new Promise<void>((r) => (release = r)));
    store.pushReplayed("crumbs", "seg1", "dep-cached", "Dep");
    const yields: unknown[] = [];
    const consumer = (async () => {
      for await (const d of store.stream()) yields.push(d.crumbs?.seg1);
    })();
    await delay(5);
    livePush(store, "Dep", "seg1", "dep-live");
    release();
    await consumer;

    expect(yields.at(0)).toEqual(["dep-cached"]);
    expect(yields.at(-1)).toEqual(["dep-live"]);
  });
});

describe("HandleStore.pushRestored (a document HIT's record copies stand)", () => {
  const bodyPush = (
    store: ReturnType<typeof createHandleStore>,
    id: string,
    segmentId: string,
    value: unknown,
  ) =>
    runInsideLoaderScope(() =>
      runInsideLoaderBodyScope(
        () => store.push("crumbs", segmentId, value),
        id,
      ),
    );

  it("drops the loader's settled pushes on the HIT: the restored copies stand, in place", () => {
    const store = createHandleStore();
    store.pushRestored("crumbs", "seg1", "captured-a", "Bake");
    store.push("crumbs", "seg1", "handler");
    store.pushRestored("crumbs", "seg1", "captured-b", "Bake");

    bodyPush(store, "Bake", "seg1", "live-a");
    bodyPush(store, "Bake", "seg1", { label: "live-b" });
    // A settled push to a handle or segment the record does not hold is
    // dropped too: the prelude did not render it.
    bodyPush(store, "Bake", "seg2", "live-extra");

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "captured-a",
      "handler",
      "captured-b",
    ]);
    expect(store.getDataForSegment("seg2")).toEqual({});
  });

  it("keeps a thenable push, and one holding a nested thenable, in the loader's push order", () => {
    const store = createHandleStore();
    store.pushRestored("crumbs", "seg1", "captured-a", "Bake");
    store.pushRestored("crumbs", "seg1", "captured-b", "Bake");
    store.push("crumbs", "seg1", "handler");
    const deferred = Promise.resolve("deferred");
    const nested = { later: Promise.resolve("nested") };

    // The run pushes: deferred, a, nested, b, deferred-tail.
    bodyPush(store, "Bake", "seg1", deferred);
    bodyPush(store, "Bake", "seg1", "live-a");
    bodyPush(store, "Bake", "seg1", nested);
    bodyPush(store, "Bake", "seg1", "live-b");
    const tail = Promise.resolve("tail");
    bodyPush(store, "Bake", "seg1", tail);

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      deferred,
      "captured-a",
      nested,
      "captured-b",
      tail,
      "handler",
    ]);
  });

  it("applies the same rule to a replay of the loader's cache() entry: settled values give way, deferred ones are added", () => {
    const store = createHandleStore();
    store.pushRestored("crumbs", "seg1", "captured", "Bake");
    const deferred = Promise.resolve("deferred");

    store.pushReplayed("crumbs", "seg1", "entry-settled", "Bake");
    store.pushReplayed("crumbs", "seg1", deferred, "Bake");

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "captured",
      deferred,
    ]);
    // A live run after the replay replaces the replayed deferred push.
    const live = Promise.resolve("live-deferred");
    bodyPush(store, "Bake", "seg1", "live-settled");
    bodyPush(store, "Bake", "seg1", live);
    expect(store.getDataForSegment("seg1").crumbs).toEqual(["captured", live]);
  });

  it("leaves other loaders and handler pushes alone", () => {
    const store = createHandleStore();
    store.pushRestored("crumbs", "seg1", "captured", "Bake");

    bodyPush(store, "Other", "seg1", "other-live");
    store.push("crumbs", "seg1", "handler-late");

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "captured",
      "other-live",
      "handler-late",
    ]);
  });

  // The capture credits a push to the innermost loader body first, then to
  // the replayed loader (shell-capture.ts deriveShellCaptureContext): a
  // "use cache" HIT inside Outer's body recorded Dep's push under Outer.
  it("a replay made inside a restored loader's body is that loader's record copy: its settled value is dropped", () => {
    const store = createHandleStore();
    store.pushRestored("crumbs", "seg1", "dep-captured", "Outer");

    runInsideLoaderBodyScope(
      () => store.pushReplayed("crumbs", "seg1", "dep-cached", "Dep"),
      "Outer",
    );

    expect(store.getDataForSegment("seg1").crumbs).toEqual(["dep-captured"]);
  });

  it("a push made in a loader body entered from a restored loader's body is that loader's too", () => {
    const store = createHandleStore();
    store.pushRestored("crumbs", "seg1", "dep-captured", "Outer");

    runInsideLoaderBodyScope(
      () =>
        runInsideLoaderBodyScope(
          () => store.push("crumbs", "seg1", "dep-live"),
          "Dep",
        ),
      "Outer",
    );

    expect(store.getDataForSegment("seg1").crumbs).toEqual(["dep-captured"]);
  });

  // A loader the route runs live is a hole: its body ends the walk for a
  // restored loader, whether or not it has a replayed push to replace.
  it("a push made in a live-lane loader's body, or in an unrestored body it entered, is not counted for a restored loader around it", () => {
    const store = createHandleStore();
    store.markLiveLane(new Set(["LiveDep"]));
    store.pushRestored("crumbs", "seg1", "outer-captured", "Outer");

    runInsideLoaderBodyScope(
      () =>
        runInsideLoaderBodyScope(() => {
          store.push("crumbs", "seg1", "live-dep");
          runInsideLoaderBodyScope(
            () => store.push("crumbs", "seg1", "inner-dep"),
            "Dep",
          );
        }, "LiveDep"),
      "Outer",
    );

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "outer-captured",
      "live-dep",
      "inner-dep",
    ]);
  });

  it("a replay of a live-lane loader's push made inside a restored loader's body stays", () => {
    const store = createHandleStore();
    store.markLiveLane(new Set(["LiveDep"]));
    store.pushRestored("crumbs", "seg1", "outer-captured", "Outer");

    runInsideLoaderBodyScope(
      () => store.pushReplayed("crumbs", "seg1", "live-dep-cached", "LiveDep"),
      "Outer",
    );

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "outer-captured",
      "live-dep-cached",
    ]);
  });
});

describe("HandleStore.pushReplayed inside a replayed loader's body (navigation replay)", () => {
  it("a replay made inside the body replaces that body's replayed copy, as the capture credited it", () => {
    const store = createHandleStore();
    store.pushReplayed("crumbs", "seg1", "dep-captured", "Outer");
    store.push("crumbs", "seg1", "handler");

    runInsideLoaderBodyScope(
      () => store.pushReplayed("crumbs", "seg1", "dep-cached", "Dep"),
      "Outer",
    );

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "dep-cached",
      "handler",
    ]);
  });

  // The capture credits a push under a live-lane loader's body to that
  // loader: its dependency, which has no replayed copy of its own, replaces
  // the loader's.
  it("a push in a body the replayed loader entered, with no replayed copy of its own, replaces the loader's copy", () => {
    const store = createHandleStore();
    store.pushReplayed("crumbs", "seg1", "inner-captured", "Live");
    store.push("crumbs", "seg1", "handler");

    runInsideLoaderBodyScope(
      () =>
        runInsideLoaderBodyScope(
          () => store.push("crumbs", "seg1", "inner-live"),
          "InnerDep",
        ),
      "Live",
    );

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "inner-live",
      "handler",
    ]);
  });
});

describe("HandleStore.settleLoaderRun (a replayed loader's run ended)", () => {
  it("drops the copies a live-lane loader's run did not replace", () => {
    const store = createHandleStore();
    store.markLiveLane(new Set(["Live"]));
    store.pushReplayed("crumbs", "seg1", "live-captured", "Live");
    store.pushReplayed("crumbs", "seg2", "live-captured-2", "Live");
    store.push("crumbs", "seg1", "handler");

    store.settleLoaderRun("Live");

    expect(store.getDataForSegment("seg1").crumbs).toEqual(["handler"]);
    expect(store.getDataForSegment("seg2").crumbs).toEqual([]);
  });

  it("keeps the live pushes of a loader that replaced its copies, and a later push lands after them", () => {
    const store = createHandleStore();
    store.markLiveLane(new Set(["Live"]));
    store.pushReplayed("crumbs", "seg1", "live-captured", "Live");
    runInsideLoaderBodyScope(
      () => store.push("crumbs", "seg1", "live-a"),
      "Live",
    );

    store.settleLoaderRun("Live");
    store.push("crumbs", "seg1", "handler");

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "live-a",
      "handler",
    ]);
  });

  it("leaves restored copies and other loaders' copies alone", () => {
    const store = createHandleStore();
    store.markLiveLane(new Set(["Live"]));
    store.pushRestored("crumbs", "seg1", "bake-captured", "Bake");
    store.pushReplayed("crumbs", "seg1", "other-captured", "Other");

    store.settleLoaderRun("Bake");
    store.settleLoaderRun("Live");

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "bake-captured",
      "other-captured",
    ]);
  });

  // A bake-lane loader's record stays authoritative, as its pin is for its
  // data: a navigation run that skips its push does not drop the replay.
  it("keeps the replayed copies of a loader outside the live lane", () => {
    const store = createHandleStore();
    store.markLiveLane(new Set(["Live"]));
    store.pushReplayed("crumbs", "seg1", "bake-captured", "Bake");

    store.settleLoaderRun("Bake");

    expect(store.getDataForSegment("seg1").crumbs).toEqual(["bake-captured"]);
  });
});

describe("HandleStore.redeliverReplays (a hole's own cache() HIT)", () => {
  it("takes the place of the values replayed for the hole before, a dependency's included", () => {
    const store = createHandleStore();
    store.markLiveLane(new Set(["Hole"]));
    store.pushReplayed("crumbs", "seg1", "hole-captured-a", "Hole");
    store.pushReplayed("crumbs", "seg1", "hole-captured-b", "Hole");
    store.push("crumbs", "seg1", "handler");

    store.redeliverReplays("Hole", () => {
      store.pushReplayed("crumbs", "seg1", "hole-cached-a", "Hole");
      store.pushReplayed("crumbs", "seg1", "dep-cached", "Dep");
    });

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "hole-cached-a",
      "dep-cached",
      "handler",
    ]);
    // Still replays: a live run of the hole replaces its own.
    runInsideLoaderBodyScope(
      () => store.push("crumbs", "seg1", "hole-live"),
      "Hole",
    );
    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "hole-live",
      "dep-cached",
      "handler",
    ]);
  });

  it("delivers as a plain replay for a loader outside the live lane", () => {
    const store = createHandleStore();
    store.markLiveLane(new Set(["Hole"]));
    store.pushReplayed("crumbs", "seg1", "bake-captured", "Bake");

    store.redeliverReplays("Bake", () => {
      store.pushReplayed("crumbs", "seg1", "bake-cached", "Bake");
    });

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "bake-captured",
      "bake-cached",
    ]);
  });

  it("appends when nothing was replayed for the loader", () => {
    const store = createHandleStore();
    store.push("crumbs", "seg1", "handler");

    store.redeliverReplays("Hole", () => {
      store.pushReplayed("crumbs", "seg1", "hole-cached", "Hole");
    });

    expect(store.getDataForSegment("seg1").crumbs).toEqual([
      "handler",
      "hole-cached",
    ]);
  });
});

describe("holdsThenable", () => {
  it("finds a thenable at the top, in plain containers, and in element props", () => {
    const promise = Promise.resolve(1);
    expect(holdsThenable(promise)).toBe(true);
    expect(holdsThenable({ a: [{ b: promise }] })).toBe(true);
    expect(holdsThenable(createElement("p", { data: promise }))).toBe(true);
  });

  it("walks what the capture's mask walks, an array's non-index properties included", () => {
    const promise = Promise.resolve(1);
    const list: unknown[] & { extra?: unknown } = ["a"];
    list.extra = promise;
    expect(holdsThenable(list)).toBe(true);
    expect(maskNestedContainerThenables(list)).not.toBe(list);
  });

  it("does not walk class instances, maps or sets, and survives cycles", () => {
    const promise = Promise.resolve(1);
    const cyclic: Record<string, unknown> = { value: "x" };
    cyclic.self = cyclic;
    expect(holdsThenable("text")).toBe(false);
    expect(holdsThenable(new Map([["p", promise]]))).toBe(false);
    expect(holdsThenable(new Set([promise]))).toBe(false);
    expect(holdsThenable(cyclic)).toBe(false);
  });
});
