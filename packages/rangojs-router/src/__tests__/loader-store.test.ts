import { describe, it, expect, beforeEach, vi } from "vitest";
import { LoaderStore, EMPTY_LOADER_SNAPSHOT } from "../loader-store.js";

describe("LoaderStore", () => {
  let store: LoaderStore;

  beforeEach(() => {
    store = new LoaderStore();
  });

  describe("snapshot identity", () => {
    it("returns the singleton EMPTY_LOADER_SNAPSHOT for unseen ids", () => {
      expect(store.getSnapshot("foo")).toBe(EMPTY_LOADER_SNAPSHOT);
    });

    it("returns a stable reference between mutations", () => {
      const id = "foo";
      const requestId = store.reserveRequestId(id);
      store.finishData(id, requestId, { v: 1 });
      const a = store.getSnapshot(id);
      const b = store.getSnapshot(id);
      expect(a).toBe(b);
    });

    it("returns a new reference after a mutation", () => {
      const id = "foo";
      const r1 = store.reserveRequestId(id);
      store.finishData(id, r1, { v: 1 });
      const a = store.getSnapshot(id);
      const r2 = store.reserveRequestId(id);
      store.finishData(id, r2, { v: 2 });
      const b = store.getSnapshot(id);
      expect(a).not.toBe(b);
      expect(b.value).toEqual({ v: 2 });
    });

    it("setLoading with the same value does not replace the snapshot", () => {
      const id = "foo";
      const r1 = store.reserveRequestId(id);
      store.finishData(id, r1, { v: 1 });
      const a = store.getSnapshot(id);
      // Reserve a new request and "set loading false" while it's already false.
      const r2 = store.reserveRequestId(id);
      store.setLoading(id, r2, false);
      expect(store.getSnapshot(id)).toBe(a);
    });
  });

  describe("subscribe / notify", () => {
    it("notifies all subscribers on each mutation", () => {
      let aCount = 0;
      let bCount = 0;
      store.subscribe("foo", () => aCount++);
      store.subscribe("foo", () => bCount++);
      const r = store.reserveRequestId("foo");
      store.finishData("foo", r, "x");
      expect(aCount).toBe(1);
      expect(bCount).toBe(1);
    });

    it("returned unsubscribe function detaches the listener", () => {
      let count = 0;
      const unsub = store.subscribe("foo", () => count++);
      const r1 = store.reserveRequestId("foo");
      store.finishData("foo", r1, "x");
      expect(count).toBe(1);
      unsub();
      const r2 = store.reserveRequestId("foo");
      store.finishData("foo", r2, "y");
      expect(count).toBe(1);
    });

    it("does not notify subscribers of a different id", () => {
      let fooCount = 0;
      let barCount = 0;
      store.subscribe("foo", () => fooCount++);
      store.subscribe("bar", () => barCount++);
      const r = store.reserveRequestId("foo");
      store.finishData("foo", r, "x");
      expect(fooCount).toBe(1);
      expect(barCount).toBe(0);
    });
  });

  describe("requestId gating", () => {
    it("finishData with a stale requestId is a no-op", () => {
      const id = "foo";
      const r1 = store.reserveRequestId(id);
      const r2 = store.reserveRequestId(id);
      // Late response from r1 arrives after r2 is in flight.
      store.finishData(id, r1, "stale");
      expect(store.getSnapshot(id).value).toBeUndefined();
      // r2 still wins when it commits.
      store.finishData(id, r2, "fresh");
      expect(store.getSnapshot(id).value).toBe("fresh");
    });

    it("finishError with a stale requestId is a no-op", () => {
      const id = "foo";
      const r1 = store.reserveRequestId(id);
      const r2 = store.reserveRequestId(id);
      store.finishError(id, r1, new Error("stale"));
      expect(store.getSnapshot(id).error).toBeNull();
      store.finishError(id, r2, new Error("fresh"));
      expect(store.getSnapshot(id).error?.message).toBe("fresh");
    });

    it("setLoading with a stale requestId is a no-op", () => {
      const id = "foo";
      const r1 = store.reserveRequestId(id);
      const r2 = store.reserveRequestId(id);
      store.setLoading(id, r2, true);
      expect(store.getSnapshot(id).isLoading).toBe(true);
      // Late "loading false" from r1 must not turn the new request's spinner off.
      store.setLoading(id, r1, false);
      expect(store.getSnapshot(id).isLoading).toBe(true);
    });

    it("does not notify subscribers when a stale write is rejected", () => {
      const id = "foo";
      const r1 = store.reserveRequestId(id);
      const r2 = store.reserveRequestId(id);
      let count = 0;
      store.subscribe(id, () => count++);
      store.finishData(id, r1, "stale");
      expect(count).toBe(0);
    });
  });

  describe("clear", () => {
    it("resets the snapshot to empty and notifies subscribers", () => {
      const id = "foo";
      const r = store.reserveRequestId(id);
      store.finishData(id, r, { v: 1 });
      let count = 0;
      store.subscribe(id, () => count++);
      store.clear(id);
      expect(store.getSnapshot(id)).toBe(EMPTY_LOADER_SNAPSHOT);
      expect(count).toBe(1);
    });

    it("invalidates in-flight requests so late commits cannot land", () => {
      const id = "foo";
      const inFlight = store.reserveRequestId(id);
      // Navigation happens before the response arrives.
      store.clear(id);
      // Late response tries to commit — must be a no-op.
      store.finishData(id, inFlight, "should-not-land");
      expect(store.getSnapshot(id)).toBe(EMPTY_LOADER_SNAPSHOT);
    });

    it("does not notify when the entry is already empty", () => {
      const id = "foo";
      let count = 0;
      store.subscribe(id, () => count++);
      // No mutations yet — clear should be a no-op for listeners.
      store.clear(id);
      expect(count).toBe(0);
    });
  });

  describe("error preserves previous value", () => {
    it("keeps the last successful value visible alongside the error", () => {
      const id = "foo";
      const r1 = store.reserveRequestId(id);
      store.finishData(id, r1, "good");
      const r2 = store.reserveRequestId(id);
      store.finishError(id, r2, new Error("boom"));
      const snap = store.getSnapshot(id);
      expect(snap.value).toBe("good");
      expect(snap.error?.message).toBe("boom");
      expect(snap.requestId).toBe(r2);
    });

    it("a successful follow-up clears the error", () => {
      const id = "foo";
      const r1 = store.reserveRequestId(id);
      store.finishError(id, r1, new Error("boom"));
      const r2 = store.reserveRequestId(id);
      store.finishData(id, r2, "good");
      const snap = store.getSnapshot(id);
      expect(snap.value).toBe("good");
      expect(snap.error).toBeNull();
    });
  });

  describe("beginRequest", () => {
    it("sets isLoading=true and clears any prior error", () => {
      const id = "foo";
      const r1 = store.reserveRequestId(id);
      store.finishError(id, r1, new Error("boom"));
      const r2 = store.reserveRequestId(id);
      store.beginRequest(id, r2);
      const snap = store.getSnapshot(id);
      expect(snap.isLoading).toBe(true);
      expect(snap.error).toBeNull();
    });

    it("preserves the last good value while clearing the error", () => {
      const id = "foo";
      const r1 = store.reserveRequestId(id);
      store.finishData(id, r1, "good");
      const r2 = store.reserveRequestId(id);
      store.finishError(id, r2, new Error("boom"));
      const r3 = store.reserveRequestId(id);
      store.beginRequest(id, r3);
      const snap = store.getSnapshot(id);
      expect(snap.value).toBe("good");
      expect(snap.error).toBeNull();
      expect(snap.isLoading).toBe(true);
    });

    it("is a no-op when isLoading is already true and there is no error", () => {
      const id = "foo";
      const r = store.reserveRequestId(id);
      store.beginRequest(id, r);
      const a = store.getSnapshot(id);
      // Re-issuing beginRequest under the same in-flight state should not
      // replace the snapshot or notify subscribers.
      let count = 0;
      store.subscribe(id, () => count++);
      store.beginRequest(id, r);
      expect(store.getSnapshot(id)).toBe(a);
      expect(count).toBe(0);
    });

    it("ignores stale request ids", () => {
      const id = "foo";
      const r1 = store.reserveRequestId(id);
      const r2 = store.reserveRequestId(id);
      store.beginRequest(id, r1);
      const snap = store.getSnapshot(id);
      // Stale call should not flip isLoading.
      expect(snap.isLoading).toBe(false);
      store.beginRequest(id, r2);
      expect(store.getSnapshot(id).isLoading).toBe(true);
    });
  });

  describe("loading state", () => {
    it("reflects setLoading toggles", () => {
      const id = "foo";
      const r = store.reserveRequestId(id);
      store.setLoading(id, r, true);
      expect(store.getSnapshot(id).isLoading).toBe(true);
      store.setLoading(id, r, false);
      expect(store.getSnapshot(id).isLoading).toBe(false);
    });

    it("finishData clears isLoading", () => {
      const id = "foo";
      const r = store.reserveRequestId(id);
      store.setLoading(id, r, true);
      store.finishData(id, r, "v");
      expect(store.getSnapshot(id).isLoading).toBe(false);
    });

    it("finishError clears isLoading", () => {
      const id = "foo";
      const r = store.reserveRequestId(id);
      store.setLoading(id, r, true);
      store.finishError(id, r, new Error("boom"));
      expect(store.getSnapshot(id).isLoading).toBe(false);
    });
  });

  // Microtasks flush before a setTimeout(0) callback, so awaiting one
  // guarantees any queued deferred-clear microtask has run.
  const flushMicrotasks = () =>
    new Promise<void>((resolve) => setTimeout(resolve, 0));

  describe("composite buckets (client refresh key)", () => {
    it("notifies only the matching bucket's listeners", () => {
      let xCount = 0;
      let yCount = 0;
      store.subscribe("L::x", () => xCount++, { loaderId: "L" });
      store.subscribe("L::y", () => yCount++, { loaderId: "L" });
      const r = store.reserveRequestId("L::x");
      store.finishData("L::x", r, 1);
      expect(xCount).toBe(1);
      expect(yCount).toBe(0);
    });

    it("keeps each bucket's value independent", () => {
      store.subscribe("L::x", () => {}, { loaderId: "L" });
      store.subscribe("L::y", () => {}, { loaderId: "L" });
      const rx = store.reserveRequestId("L::x");
      store.finishData("L::x", rx, "x-val");
      const ry = store.reserveRequestId("L::y");
      store.finishData("L::y", ry, "y-val");
      expect(store.getSnapshot("L::x").value).toBe("x-val");
      expect(store.getSnapshot("L::y").value).toBe("y-val");
    });
  });

  describe("clearFamily", () => {
    it("resets every sticky bucket belonging to the loader id", () => {
      store.subscribe("L", () => {}, { loaderId: "L" });
      store.subscribe("L::x", () => {}, { loaderId: "L" });
      const r1 = store.reserveRequestId("L");
      store.finishData("L", r1, "a");
      const r2 = store.reserveRequestId("L::x");
      store.finishData("L::x", r2, "b");
      store.clearFamily("L");
      expect(store.getSnapshot("L")).toBe(EMPTY_LOADER_SNAPSHOT);
      expect(store.getSnapshot("L::x")).toBe(EMPTY_LOADER_SNAPSHOT);
    });

    it("invalidates in-flight requests for every bucket", () => {
      store.subscribe("L::x", () => {}, { loaderId: "L" });
      const inFlight = store.reserveRequestId("L::x");
      store.clearFamily("L");
      // Late response tries to commit after the family was cleared.
      store.finishData("L::x", inFlight, "late");
      expect(store.getSnapshot("L::x")).toBe(EMPTY_LOADER_SNAPSHOT);
    });

    it("does not touch buckets of another loader id", () => {
      store.subscribe("L", () => {}, { loaderId: "L" });
      store.subscribe("M", () => {}, { loaderId: "M" });
      const rL = store.reserveRequestId("L");
      store.finishData("L", rL, "l");
      const rM = store.reserveRequestId("M");
      store.finishData("M", rM, "m");
      store.clearFamily("L");
      expect(store.getSnapshot("L")).toBe(EMPTY_LOADER_SNAPSHOT);
      expect(store.getSnapshot("M").value).toBe("m");
    });

    it("leaves ephemeral buckets untouched (they are refcount-governed)", () => {
      // An ephemeral subscriber stays mounted, so the bucket survives.
      store.subscribe("L::cart", () => {}, { loaderId: "L", ephemeral: true });
      const r = store.reserveRequestId("L::cart");
      store.finishData("L::cart", r, "kept");
      store.clearFamily("L");
      expect(store.getSnapshot("L::cart").value).toBe("kept");
    });
  });

  describe("ephemeral refcount lifecycle", () => {
    it("drops the bucket after the last subscriber unsubscribes", async () => {
      const unsub = store.subscribe("L::cart", () => {}, {
        loaderId: "L",
        ephemeral: true,
      });
      const r = store.reserveRequestId("L::cart");
      store.finishData("L::cart", r, "v");
      expect(store.getSnapshot("L::cart").value).toBe("v");
      unsub();
      await flushMicrotasks();
      expect(store.getSnapshot("L::cart")).toBe(EMPTY_LOADER_SNAPSHOT);
    });

    it("a resubscribe before the microtask cancels the drop", async () => {
      const unsub = store.subscribe("L::cart", () => {}, {
        loaderId: "L",
        ephemeral: true,
      });
      const r = store.reserveRequestId("L::cart");
      store.finishData("L::cart", r, "v");
      unsub();
      // StrictMode / transition remount resubscribes synchronously.
      store.subscribe("L::cart", () => {}, { loaderId: "L", ephemeral: true });
      await flushMicrotasks();
      expect(store.getSnapshot("L::cart").value).toBe("v");
    });

    it("defers the drop until an in-flight load settles", async () => {
      const unsub = store.subscribe("L::cart", () => {}, {
        loaderId: "L",
        ephemeral: true,
      });
      const r = store.reserveRequestId("L::cart");
      store.beginRequest("L::cart", r);
      unsub();
      await flushMicrotasks();
      // Mid-flight: the drop is deferred, the entry is still present.
      expect(store.getSnapshot("L::cart").isLoading).toBe(true);
      // Once the request settles with no subscribers, the bucket is dropped.
      store.finishData("L::cart", r, "late");
      expect(store.getSnapshot("L::cart")).toBe(EMPTY_LOADER_SNAPSHOT);
    });

    it("keeps a sticky (registered) bucket after the last subscriber leaves", async () => {
      const unsub = store.subscribe("L", () => {}, { loaderId: "L" });
      const r = store.reserveRequestId("L");
      store.finishData("L", r, "v");
      unsub();
      await flushMicrotasks();
      // Sticky buckets persist for remount; they reset via clearFamily.
      expect(store.getSnapshot("L").value).toBe("v");
    });

    it("a non-ephemeral subscriber makes a shared bucket sticky", async () => {
      const unsubEph = store.subscribe("L::g", () => {}, {
        loaderId: "L",
        ephemeral: true,
      });
      const unsubReg = store.subscribe("L::g", () => {}, {
        loaderId: "L",
        ephemeral: false,
      });
      const r = store.reserveRequestId("L::g");
      store.finishData("L::g", r, "v");
      // Ephemeral subscriber leaves but a registered one remains: kept.
      unsubEph();
      await flushMicrotasks();
      expect(store.getSnapshot("L::g").value).toBe("v");
      // Registered subscriber leaves too: still kept (sticky for life).
      unsubReg();
      await flushMicrotasks();
      expect(store.getSnapshot("L::g").value).toBe("v");
      // clearFamily resets sticky buckets.
      store.clearFamily("L");
      expect(store.getSnapshot("L::g")).toBe(EMPTY_LOADER_SNAPSHOT);
    });
  });

  describe("refreshGroups (cross-loader)", () => {
    it("calls the refetch thunk for each bucket in the group", async () => {
      const a = vi.fn().mockResolvedValue(undefined);
      const b = vi.fn().mockResolvedValue(undefined);
      store.subscribe("La::u", () => {}, {
        loaderId: "La",
        group: "account",
        refetch: a,
      });
      store.subscribe("Lb::u", () => {}, {
        loaderId: "Lb",
        group: "account",
        refetch: b,
      });
      await store.refreshGroups("account");
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });

    it("dedups multiple readers of one bucket to a single refetch", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      store.subscribe("La::u", () => {}, {
        loaderId: "La",
        group: "account",
        refetch: fn,
      });
      store.subscribe("La::u", () => {}, {
        loaderId: "La",
        group: "account",
        refetch: fn,
      });
      await store.refreshGroups("account");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("skips buckets whose last subscriber has left", async () => {
      const a = vi.fn().mockResolvedValue(undefined);
      const b = vi.fn().mockResolvedValue(undefined);
      store.subscribe("La::u", () => {}, {
        loaderId: "La",
        group: "account",
        refetch: a,
      });
      const unsubB = store.subscribe("Lb::u", () => {}, {
        loaderId: "Lb",
        group: "account",
        refetch: b,
      });
      unsubB();
      await store.refreshGroups("account");
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).not.toHaveBeenCalled();
    });

    it("rejects with an AggregateError when a member fails, running the rest", async () => {
      const ok = vi.fn().mockResolvedValue(undefined);
      const bad = vi.fn().mockRejectedValue(new Error("boom"));
      store.subscribe("La::u", () => {}, {
        loaderId: "La",
        group: "account",
        refetch: ok,
      });
      store.subscribe("Lb::u", () => {}, {
        loaderId: "Lb",
        group: "account",
        refetch: bad,
      });
      await expect(store.refreshGroups("account")).rejects.toBeInstanceOf(
        AggregateError,
      );
      // The healthy member still ran despite the sibling's failure.
      expect(ok).toHaveBeenCalledTimes(1);
    });

    it("is a no-op for an unknown group", async () => {
      await expect(store.refreshGroups("nope")).resolves.toBeUndefined();
    });

    it("lets one bucket belong to multiple groups (different subscribers)", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      // Same bucket (same loader + key), two subscribers, different groups.
      store.subscribe("L::k", () => {}, {
        loaderId: "L",
        group: "g1",
        refetch: fn,
      });
      store.subscribe("L::k", () => {}, {
        loaderId: "L",
        group: "g2",
        refetch: fn,
      });
      await store.refreshGroups("g1");
      expect(fn).toHaveBeenCalledTimes(1);
      await store.refreshGroups("g2");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("keeps a bucket in its other groups when one group's subscriber leaves", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      store.subscribe("L::k", () => {}, {
        loaderId: "L",
        group: "g1",
        refetch: fn,
      });
      const unsub2 = store.subscribe("L::k", () => {}, {
        loaderId: "L",
        group: "g2",
        refetch: fn,
      });
      unsub2();
      // g2 lost its only subscriber, so the bucket left g2 — but stays in g1.
      await store.refreshGroups("g2");
      expect(fn).not.toHaveBeenCalled();
      await store.refreshGroups("g1");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("refcounts membership per group, independent of unsubscribe order", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      const u1 = store.subscribe("L::k", () => {}, {
        loaderId: "L",
        group: "g",
        refetch: fn,
      });
      const u2 = store.subscribe("L::k", () => {}, {
        loaderId: "L",
        group: "g",
        refetch: fn,
      });
      u1();
      // One subscriber still wants group "g", so the bucket remains in it.
      await store.refreshGroups("g");
      expect(fn).toHaveBeenCalledTimes(1);
      u2();
      // Now the last "g" subscriber is gone — the bucket leaves the group.
      await store.refreshGroups("g");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("a single subscriber tagged with multiple groups joins all of them", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      // One read, tagged into two groups at once via an array.
      store.subscribe("L::k", () => {}, {
        loaderId: "L",
        group: ["g1", "g2"],
        refetch: fn,
      });
      await store.refreshGroups("g1");
      expect(fn).toHaveBeenCalledTimes(1);
      await store.refreshGroups("g2");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("refreshGroups(array) refreshes the union of members across the named groups", async () => {
      const a = vi.fn().mockResolvedValue(undefined);
      const b = vi.fn().mockResolvedValue(undefined);
      store.subscribe("La::u", () => {}, {
        loaderId: "La",
        group: "g1",
        refetch: a,
      });
      store.subscribe("Lb::u", () => {}, {
        loaderId: "Lb",
        group: "g2",
        refetch: b,
      });
      await store.refreshGroups(["g1", "g2"]);
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });

    it("refreshGroups(array) fetches a bucket in two of the named groups only once", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      store.subscribe("L::k", () => {}, {
        loaderId: "L",
        group: ["g1", "g2"],
        refetch: fn,
      });
      // The bucket is a member of both requested groups — union+dedup means one
      // refetch, not two.
      await store.refreshGroups(["g1", "g2"]);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("dedups repeated group names in a single subscriber's tag list", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      const unsub = store.subscribe("L::k", () => {}, {
        loaderId: "L",
        group: ["g", "g"],
        refetch: fn,
      });
      await store.refreshGroups("g");
      expect(fn).toHaveBeenCalledTimes(1);
      // A repeated tag must not inflate the refcount: one unsubscribe fully
      // removes the bucket from the group.
      unsub();
      await store.refreshGroups("g");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("a multi-tag subscriber leaves all of its groups on unsubscribe", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      const unsub = store.subscribe("L::k", () => {}, {
        loaderId: "L",
        group: ["g1", "g2"],
        refetch: fn,
      });
      unsub();
      await store.refreshGroups("g1");
      await store.refreshGroups("g2");
      expect(fn).not.toHaveBeenCalled();
    });

    it("is a no-op for an empty group list", async () => {
      await expect(store.refreshGroups([])).resolves.toBeUndefined();
    });
  });
});
