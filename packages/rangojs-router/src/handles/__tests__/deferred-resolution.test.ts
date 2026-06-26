import { describe, it, expect } from "vitest";
import { createHandle, collectHandleData } from "../../handle.js";
import { createHandleStore } from "../../server/handle-store.js";
import {
  resolveDeferredHandleValues,
  resolveSegmentHandleValues,
  resolvedHandleStream,
  deferredHandleNames,
} from "../deferred-resolution.js";

// The resolve-by-default contract: a pushed value is awaited IFF the value itself
// is a thenable (shallow). Top-level promises resolve, rejections drop, and a
// value that merely CONTAINS a promise (`{ data: promise }`) passes through
// verbatim. These are the load-bearing heuristics the server full-render path and
// the client hold-until-resolved path both rely on.

describe("root accumulation across layouts + parallel slots", () => {
  // The user-facing concern: handle values accumulate from EVERY segment in the
  // matched chain — root layout, nested layouts, the leaf, AND parallel slots
  // (each slot keys into its OWN bucket `parent.@slot`, see fresh.ts). A consumer
  // reading the handle at the root (e.g. <MetaTags/>) collects the whole chain.
  // With resolve-by-default, a DEFERRED push from any of those segments must be
  // resolved before that root read — including one pushed from a parallel slot.
  it("a deferred value pushed from a parallel slot is resolved before the root collects the whole chain", async () => {
    const Crumbs = createHandle<string, string[]>(
      (segments) => segments.flat(),
      "__test_root_accum__",
    );

    // Matched chain: root layout L0 (sync push) + its parallel slot L0.@panel
    // (DEFERRED push) + leaf R0 (sync push).
    const snapshot = {
      [Crumbs.$$id]: {
        L0: ["from-layout"],
        "L0.@panel": [Promise.resolve("from-slot-deferred")],
        R0: ["from-leaf"],
      },
    };

    // The slot's deferred value is visible to the client hold-and-resolve path.
    expect(deferredHandleNames(snapshot)).toEqual(new Set([Crumbs.$$id]));

    // Server full-render and client soft-nav both run this before any consumer.
    const resolved = await resolveDeferredHandleValues(snapshot);

    // The root read collects the whole chain in segment order; the slot's value
    // is already resolved — no Promise reaches collect.
    const atRoot = collectHandleData(Crumbs, resolved, [
      "L0",
      "L0.@panel",
      "R0",
    ]);
    expect(atRoot).toEqual(["from-layout", "from-slot-deferred", "from-leaf"]);
  });
});

describe("collect shape: default per-segment grouping vs opt-in flat", () => {
  // The chain: a top-level parallel slot pushed ONCE, the route handler pushed
  // TWICE. The data handed to `collect` is grouped per segment (TData[][], one
  // inner array per segment in segmentOrder). The DEFAULT collect now passes that
  // through as-is, so a consumer can tell which/how-many segments pushed.
  const buckets = {
    "L0.@panel": ["from-slot"], // parallel slot: one push
    R0: ["handler-1", "handler-2"], // route handler: two pushes
  };
  const order = ["L0.@panel", "R0"];

  it("default collect (no arg) keeps the per-segment grouping as-is", () => {
    // No collect -> identity. A single-push segment is [x] and a two-push segment
    // is [x, y], so they are distinguishable.
    const H = createHandle<string>(undefined, "__test_collect_default__");
    expect(collectHandleData(H, { [H.$$id]: buckets }, order)).toEqual([
      ["from-slot"],
      ["handler-1", "handler-2"],
    ]);
  });

  it("opt-in flat collect erases segment boundaries into one array", () => {
    const H = createHandle<string, string[]>(
      (segments) => segments.flat(),
      "__test_collect_flat__",
    );
    expect(collectHandleData(H, { [H.$$id]: buckets }, order)).toEqual([
      "from-slot",
      "handler-1",
      "handler-2",
    ]);
  });
});

describe("resolveDeferredHandleValues", () => {
  it("resolves top-level promises and leaves sync values untouched", async () => {
    const out = await resolveDeferredHandleValues({
      H: { seg1: [Promise.resolve("async"), "sync"] },
    });
    expect(out).toEqual({ H: { seg1: ["async", "sync"] } });
  });

  it("drops a rejected promise (degrade, never throw)", async () => {
    const out = await resolveDeferredHandleValues({
      H: { seg1: [Promise.reject(new Error("boom")), "kept"] },
    });
    expect(out).toEqual({ H: { seg1: ["kept"] } });
  });

  it("drops a DEFERRED that resolves to null/undefined, but keeps a SYNC nullish push", async () => {
    // A `.defer()` that times out (no `else`) resolves to undefined; `else: null`
    // does the same. A nullish DEFERRED value is dropped so it never reaches a
    // collector. But a SYNC null push is not a thenable, so it passes through
    // (the "await iff thenable" contract — a createHandle<T | null>() may use it).
    const out = await resolveDeferredHandleValues({
      H: {
        seg1: [
          Promise.resolve(undefined), // deferred -> dropped
          Promise.resolve(null), // deferred -> dropped
          null, // sync nullish -> kept
          "kept",
        ],
      },
    });
    expect(out).toEqual({ H: { seg1: [null, "kept"] } });
  });

  it("is SHALLOW — a promise nested in an object is NOT awaited", async () => {
    const nested = Promise.resolve("inner");
    const out = await resolveDeferredHandleValues({
      H: { seg1: [{ data: nested }] },
    });
    // The object passes through by value; its nested promise keeps its identity.
    expect(out.H.seg1).toHaveLength(1);
    expect((out.H.seg1[0] as { data: unknown }).data).toBe(nested);
  });

  it("resolves every bucket (no scope) and drops a rejected entry", async () => {
    const out = await resolveDeferredHandleValues({
      Meta: { seg1: [Promise.resolve("title")] },
      Other: { seg1: [Promise.resolve("x"), Promise.reject(new Error("e"))] },
    });
    expect(out.Meta).toEqual({ seg1: ["title"] });
    expect(out.Other).toEqual({ seg1: ["x"] });
  });
});

describe("deferredHandleNames", () => {
  it("returns the handle names with a top-level thenable; ignores nested", () => {
    const names = deferredHandleNames({
      Deferred: { s: [Promise.resolve(1)] },
      Sync: { s: ["plain"] },
      Nested: { s: [{ p: Promise.resolve(1) }] },
    });
    expect([...names]).toEqual(["Deferred"]);
  });

  it("is empty when no bucket is deferred (so `.size > 0` answers has-any)", () => {
    expect(deferredHandleNames({ H: { s: ["a", "b"] } }).size).toBe(0);
  });
});

describe("resolveSegmentHandleValues (segment-keyed shape)", () => {
  it("resolves top-level promises, drops rejections, keeps nested promises", async () => {
    const nested = Promise.resolve("inner");
    const out = await resolveSegmentHandleValues({
      Breadcrumbs: [Promise.resolve("crumb"), "sync"],
      Bad: [Promise.reject(new Error("x"))],
      Wrapped: [{ data: nested }],
    });
    expect(out.Breadcrumbs).toEqual(["crumb", "sync"]);
    expect(out.Bad).toEqual([]);
    expect((out.Wrapped[0] as { data: unknown }).data).toBe(nested);
  });
});

describe("resolvedHandleStream (full-render drop-in for handleStore.stream())", () => {
  it("yields one final snapshot with deferred values resolved, then completes", async () => {
    const store = createHandleStore();
    store.push("H", "seg1", Promise.resolve("resolved"));
    store.push("H", "seg1", "sync");

    const gen = resolvedHandleStream(store);
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual({ H: { seg1: ["resolved", "sync"] } });

    const second = await gen.next();
    expect(second.done).toBe(true);
  });

  it("waits for tracked handler promises (settled) before resolving", async () => {
    const store = createHandleStore();
    let pushed = false;
    // A tracked handler that pushes late: settled must gate the yield so the
    // late push is included.
    store.track(
      Promise.resolve().then(() => {
        store.push("H", "seg1", Promise.resolve("late"));
        pushed = true;
      }),
    );

    const value = (await resolvedHandleStream(store).next()).value;
    expect(pushed).toBe(true);
    expect(value).toEqual({ H: { seg1: ["late"] } });
  });

  it("preserves the late-push guard: a push() after the stream drains throws", async () => {
    // Regression: the full-render path must keep stream()'s `completed` flag so an
    // async JSX subtree that suspended and pushes AFTER collection errors clearly
    // (LateHandlePushError) instead of silently landing. getData() never sets
    // `completed`, so resolvedHandleStream drains stream(), not getData().
    const store = createHandleStore();
    store.push("H", "seg1", "early");

    const gen = resolvedHandleStream(store);
    await gen.next(); // the resolved snapshot
    await gen.next(); // done -> collection completed

    expect(() => store.push("H", "seg1", "late")).toThrow(
      /pushed after handle collection completed/,
    );
  });
});
