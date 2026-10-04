import { describe, it, expect, vi, afterEach } from "vitest";
import {
  collectTransitionWhens,
  createTransitionWhenContext,
  decideCommitGatedOff,
  decideTransitionGatedOff,
  findActionFormData,
} from "../browser/transition-when.js";
import { shouldStartViewTransition } from "../browser/partial-update.js";
import { createClientUrlsWhenRef } from "../transition-when-ref.js";
import type {
  ResolvedSegment,
  TransitionWhenContext,
} from "../types/segments.js";
import type { NavigationStore } from "../browser/types.js";

function seg(
  id: string,
  extra: Partial<ResolvedSegment> = {},
): ResolvedSegment {
  return {
    id,
    namespace: "r",
    type: "route",
    index: 0,
    component: null,
    ...extra,
  } as ResolvedSegment;
}

const PUSH = {
  kind: "push" as const,
  from: { url: "http://localhost/a", params: { n: "a" }, routeName: "tx" },
  to: { url: "http://localhost/b", params: { n: "b" }, routeName: "tx" },
};
const push = () => PUSH;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createTransitionWhenContext", () => {
  it("builds frozen from/to locations and an isAction that is false off an action", () => {
    const ctx = createTransitionWhenContext({
      ...PUSH,
      to: { ...PUSH.to, state: { __rsc_ls_x: 1 } },
    });
    expect(ctx.kind).toBe("push");
    expect(ctx.from.url.pathname).toBe("/a");
    expect(ctx.to).toMatchObject({
      params: { n: "b" },
      routeName: "tx",
      state: { __rsc_ls_x: 1 },
    });
    expect(ctx.isAction()).toBe(false);
    expect(ctx.action).toBeUndefined();
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.to.params)).toBe(true);
  });

  it("uses `from` as `to` for action and revalidate, and carries action fields", () => {
    const addToCart = Object.assign(() => {}, { $$id: "cart#add" });
    const formData = new FormData();
    const action = createTransitionWhenContext({
      kind: "action",
      from: PUSH.from,
      to: PUSH.to,
      action: { id: "cart#add", formData, result: { ok: 1 } },
    });
    expect(action.to).toBe(action.from);
    expect(action.isAction()).toBe(true);
    expect(action.isAction(addToCart)).toBe(true);
    expect(action.action).toEqual({
      id: "cart#add",
      formData,
      result: { ok: 1 },
      error: undefined,
    });

    const revalidate = createTransitionWhenContext({
      kind: "revalidate",
      from: PUSH.from,
    });
    expect(revalidate.to).toBe(revalidate.from);
    expect(revalidate.action).toBeUndefined();
  });
});

describe("decideTransitionGatedOff", () => {
  it("is not gated off when no segment declares when (and never builds a context)", () => {
    const input = vi.fn(() => PUSH);
    expect(decideTransitionGatedOff([seg("R0")], input)).toBe(false);
    expect(input).not.toHaveBeenCalled();
  });

  it("ANDs every committed segment's predicate, kept or re-sent (#989), deduped by identity", () => {
    const shared = vi.fn(() => true);
    const layoutWhen = vi.fn(() => true);
    const segments = [
      seg("L0", { type: "layout", transition: { when: layoutWhen } }),
      seg("L0L1", { type: "layout", transition: { when: shared } }),
      seg("L0L1R0", { transition: { when: shared } }),
    ];
    expect(decideTransitionGatedOff(segments, push)).toBe(false);
    expect(layoutWhen).toHaveBeenCalledTimes(1);
    expect(shared).toHaveBeenCalledTimes(1);

    const layoutFalse = vi.fn(() => false);
    expect(
      decideTransitionGatedOff(
        [
          seg("L0", { type: "layout", transition: { when: layoutFalse } }),
          seg("L0R0", { transition: {} }),
        ],
        push,
      ),
    ).toBe(true);
  });

  it("treats a throw as false and logs it", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const gatedOff = decideTransitionGatedOff(
      [
        seg("R0", {
          transition: {
            when: () => {
              throw new Error("boom");
            },
          },
        }),
      ],
      push,
    );
    expect(gatedOff).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain(
      "transition({ when }) threw",
    );
  });

  it("does not evaluate on an intercept commit", () => {
    const when = vi.fn(() => false);
    const gatedOff = decideTransitionGatedOff(
      [
        seg("L0", { type: "layout", transition: { when } }),
        seg("L0.@modal", { type: "parallel", namespace: "intercept:@modal" }),
      ],
      push,
    );
    expect(gatedOff).toBe(false);
    expect(when).not.toHaveBeenCalled();
  });

  it("adds `extra` predicates (the optimistic clientUrls destination) to the segments'", () => {
    const destination = vi.fn((ctx: TransitionWhenContext) => {
      return ctx.to.routeName === "items.detail";
    });
    expect(
      decideTransitionGatedOff(
        [seg("L0", { type: "layout" })],
        () => ({ ...PUSH, to: { ...PUSH.to, routeName: "items.detail" } }),
        destination,
      ),
    ).toBe(false);
    expect(destination).toHaveBeenCalledTimes(1);
  });

  it("resolves a clientUrls when reference to the route's declared when", () => {
    const when = vi.fn(() => false);
    const definition = { routes: [{ id: "r1", transition: { when } }] };
    expect([
      ...collectTransitionWhens([
        seg("R0", {
          transition: { when: createClientUrlsWhenRef(definition, "r1") },
        }),
      ]),
    ]).toEqual([when]);
  });
});

describe("shouldStartViewTransition", () => {
  it("holds only when not gated off, some segment has a transition, and no intercept presents", () => {
    const withTx = [seg("R0", { transition: {} })];
    expect(shouldStartViewTransition(withTx, false)).toBe(true);
    expect(shouldStartViewTransition(withTx, true)).toBe(false);
    expect(shouldStartViewTransition([seg("R0")], false)).toBe(false);
    expect(
      shouldStartViewTransition(
        [
          ...withTx,
          seg("L0.@modal", { type: "parallel", namespace: "intercept:@m" }),
        ],
        false,
      ),
    ).toBe(false);
  });
});

describe("decideCommitGatedOff", () => {
  function storeWith(memory: { routeName?: string; state?: unknown }) {
    return {
      getSegmentState: () => ({
        path: "/a",
        currentUrl: "http://localhost/a",
        currentSegmentIds: [],
      }),
      getHistoryKey: () => "/a",
      getCachedSegments: () => ({
        segments: [seg("R0", { params: { n: "a" } })],
        stale: false,
      }),
      getHistoryEntryMemory: () => ({
        routeName: memory.routeName,
        state: memory.state,
      }),
    } as unknown as NavigationStore;
  }

  function seen(
    store: NavigationStore,
    kind: "push" | "pop" | "action",
    decision: Parameters<typeof decideCommitGatedOff>[3] = {},
  ): TransitionWhenContext {
    let ctx: TransitionWhenContext | undefined;
    const when = (c: TransitionWhenContext) => {
      ctx = c;
      return true;
    };
    decideCommitGatedOff(
      store,
      [seg("R0", { transition: { when } })],
      kind,
      decision,
    );
    return ctx!;
  }

  it("reads `from` from the store: live history.state, except on pop where the entry left comes from memory", () => {
    vi.stubGlobal("window", {
      location: { href: "http://localhost/b" },
      history: { state: { key: "b", mark: "destination" } },
    });
    const store = storeWith({ routeName: "tx", state: { mark: "left" } });

    const push = seen(store, "push", {
      to: (from) => ({ ...from, url: "http://localhost/b" }),
    });
    expect(push.from).toMatchObject({
      params: { n: "a" },
      routeName: "tx",
      state: { key: "b", mark: "destination" },
    });
    expect(push.from.url.pathname).toBe("/a");
    expect(push.to.url.pathname).toBe("/b");
    expect(seen(store, "pop").from.state).toEqual({ mark: "left" });
  });

  it("lets an action response refresh the committed params and route name", () => {
    vi.stubGlobal("window", {
      location: { href: "http://localhost/a" },
      history: { state: null },
    });
    const ctx = seen(storeWith({ routeName: "old" }), "action", {
      from: { params: { n: "z" }, routeName: "fresh" },
      action: { id: "a#b" },
    });
    expect(ctx.from).toMatchObject({ params: { n: "z" }, routeName: "fresh" });
    expect(ctx.to).toBe(ctx.from);
    expect(ctx.action?.id).toBe("a#b");
  });
});

describe("findActionFormData", () => {
  it("finds the FormData argument (2nd under useActionState)", () => {
    const formData = new FormData();
    expect(findActionFormData([formData])).toBe(formData);
    expect(findActionFormData([{ prev: 1 }, formData])).toBe(formData);
    expect(findActionFormData(["id", 3])).toBeUndefined();
  });
});
