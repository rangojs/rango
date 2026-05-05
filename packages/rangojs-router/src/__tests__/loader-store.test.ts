import { describe, it, expect, beforeEach } from "vitest";
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
});
