import { describe, it, expect } from "vitest";
import {
  classifyActionOutcome,
  type ActionOutcomeInput,
} from "../browser/action-coordinator";
import type { ActionEntry } from "../browser/event-controller";

function makeEntry(
  overrides?: Partial<ActionEntry> & { id?: string },
): ActionEntry {
  return {
    id: overrides?.id ?? "action-1",
    actionId: "hash#test",
    abort: new AbortController(),
    phase: "fetching",
    payload: [],
    revalidatedSegments: [],
    startedAt: Date.now(),
    ...overrides,
  };
}

function baseInput(
  overrides?: Partial<ActionOutcomeInput>,
): ActionOutcomeInput {
  return {
    handleId: "action-1",
    inflightActions: new Map(),
    hadAnyConcurrentActions: false,
    revalidatedSegments: new Set(),
    actionStartPathname: "/page",
    currentPathname: "/page",
    actionStartLocationKey: "key1",
    currentLocationKey: "key1",
    reconciledSegmentCount: 3,
    matchedCount: 3,
    currentInterceptSource: null,
    ...overrides,
  };
}

describe("classifyActionOutcome", () => {
  it("returns normal for a single action with no issues", () => {
    expect(classifyActionOutcome(baseInput())).toEqual({ type: "normal" });
  });

  describe("navigated-away scenario", () => {
    it("detects a changed pathname (keys match -> historyKeyChanged false)", () => {
      expect(
        classifyActionOutcome(baseInput({ currentPathname: "/other" })),
      ).toEqual({
        type: "navigated-away",
        historyKeyChanged: false,
        onInterceptRoute: false,
      });
    });

    it("detects a changed history key (historyKeyChanged true)", () => {
      expect(
        classifyActionOutcome(baseInput({ currentLocationKey: "key2" })),
      ).toEqual({
        type: "navigated-away",
        historyKeyChanged: true,
        onInterceptRoute: false,
      });
    });

    it("sets onInterceptRoute when on an intercept route", () => {
      const result = classifyActionOutcome(
        baseInput({
          currentLocationKey: "key2",
          currentInterceptSource: "/source",
        }),
      );
      expect(result).toMatchObject({
        type: "navigated-away",
        onInterceptRoute: true,
      });
    });
  });

  it("returns hmr-missing when reconciled < matched", () => {
    const result = classifyActionOutcome(
      baseInput({ reconciledSegmentCount: 1, matchedCount: 3 }),
    );
    expect(result).toEqual({ type: "hmr-missing" });
  });

  describe("consolidation logic", () => {
    it("returns consolidation-needed when concurrent actions finished and segments recorded", () => {
      const actions = new Map<string, ActionEntry>();
      // Both actions have completed (streaming phase, not fetching)
      actions.set("a-1", makeEntry({ id: "a-1", phase: "streaming" }));
      actions.set("a-2", makeEntry({ id: "a-2", phase: "streaming" }));

      const result = classifyActionOutcome(
        baseInput({
          handleId: "a-2",
          inflightActions: actions,
          hadAnyConcurrentActions: true,
          revalidatedSegments: new Set(["seg1", "seg2"]),
        }),
      );
      expect(result).toEqual({
        type: "consolidation-needed",
        segmentIds: expect.arrayContaining(["seg1", "seg2"]),
      });
    });

    it("returns concurrent-skip when another action is still fetching", () => {
      const actions = new Map<string, ActionEntry>();
      actions.set("a-1", makeEntry({ id: "a-1", phase: "fetching" }));
      actions.set("a-2", makeEntry({ id: "a-2", phase: "streaming" }));

      const result = classifyActionOutcome(
        baseInput({
          handleId: "a-2",
          inflightActions: actions,
          hadAnyConcurrentActions: true,
          revalidatedSegments: new Set(["seg1"]),
        }),
      );
      expect(result).toEqual({
        type: "concurrent-skip",
        otherFetchingCount: 1,
      });
    });

    it("skips consolidation when hadAnyConcurrentActions is false", () => {
      const actions = new Map<string, ActionEntry>();
      actions.set("a-1", makeEntry({ id: "a-1", phase: "streaming" }));

      const result = classifyActionOutcome(
        baseInput({
          handleId: "a-1",
          inflightActions: actions,
          hadAnyConcurrentActions: false,
          revalidatedSegments: new Set(["seg1"]),
        }),
      );
      expect(result).toEqual({ type: "normal" });
    });

    it("skips consolidation when revalidated segments are empty", () => {
      const actions = new Map<string, ActionEntry>();
      actions.set("a-1", makeEntry({ id: "a-1", phase: "streaming" }));

      const result = classifyActionOutcome(
        baseInput({
          handleId: "a-1",
          inflightActions: actions,
          hadAnyConcurrentActions: true,
          revalidatedSegments: new Set(),
        }),
      );
      expect(result).toEqual({ type: "normal" });
    });

    it("defers consolidation while any action is still fetching", () => {
      const actions = new Map<string, ActionEntry>();
      actions.set("a-1", makeEntry({ id: "a-1", phase: "fetching" }));
      actions.set("a-2", makeEntry({ id: "a-2", phase: "streaming" }));

      const result = classifyActionOutcome(
        baseInput({
          handleId: "a-2",
          inflightActions: actions,
          hadAnyConcurrentActions: true,
          revalidatedSegments: new Set(["seg1"]),
        }),
      );
      // Should be concurrent-skip (other action is fetching), not consolidation
      expect(result.type).toBe("concurrent-skip");
    });

    it("first-started action triggers consolidation when it finishes last", () => {
      // Regression test: A starts alone, B overlaps, B finishes, A finishes last.
      // hadAnyConcurrentActions is the controller-level flag (true for all handles
      // once concurrency is detected), not the per-handle flag.
      const actions = new Map<string, ActionEntry>();
      // A is still in-flight (streaming), B already settled and was removed
      actions.set("a-1", makeEntry({ id: "a-1", phase: "streaming" }));

      const result = classifyActionOutcome(
        baseInput({
          handleId: "a-1",
          inflightActions: actions,
          hadAnyConcurrentActions: true, // controller saw concurrency
          revalidatedSegments: new Set(["seg1", "seg2"]),
        }),
      );
      expect(result).toEqual({
        type: "consolidation-needed",
        segmentIds: expect.arrayContaining(["seg1", "seg2"]),
      });
    });
  });

  describe("other-fetching-action count excludes own handle", () => {
    it("does not count itself", () => {
      const actions = new Map<string, ActionEntry>();
      actions.set("a-1", makeEntry({ id: "a-1", phase: "fetching" }));

      // handleId matches the only fetching action — count should be 0
      const result = classifyActionOutcome(
        baseInput({
          handleId: "a-1",
          inflightActions: actions,
        }),
      );
      expect(result).toEqual({ type: "normal" });
    });
  });

  describe("priority ordering", () => {
    it("navigated-away outranks hmr-missing", () => {
      const result = classifyActionOutcome(
        baseInput({ currentPathname: "/other", reconciledSegmentCount: 1 }),
      );
      expect(result.type).toBe("navigated-away");
    });

    it("hmr-missing outranks consolidation", () => {
      const actions = new Map<string, ActionEntry>();
      actions.set("a-1", makeEntry({ id: "a-1", phase: "streaming" }));
      const result = classifyActionOutcome(
        baseInput({
          handleId: "a-1",
          reconciledSegmentCount: 1,
          matchedCount: 3,
          inflightActions: actions,
          hadAnyConcurrentActions: true,
          revalidatedSegments: new Set(["seg1"]),
        }),
      );
      expect(result).toEqual({ type: "hmr-missing" });
    });
  });
});
