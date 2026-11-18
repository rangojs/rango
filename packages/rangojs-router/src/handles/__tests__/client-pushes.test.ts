import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventController } from "../../browser/event-controller.js";
import {
  samePushValue,
  withClientPushes,
  type ClientPushes,
  type ClientPushOwner,
} from "../client-pushes.js";

describe("samePushValue", () => {
  it.each<[string, unknown, unknown, boolean]>([
    ["equal primitives", "a", "a", true],
    ["NaN", NaN, NaN, true],
    ["different primitives", "a", "b", false],
    [
      "fresh nested objects",
      { a: { b: [1, { c: 2 }] } },
      { a: { b: [1, { c: 2 }] } },
      true,
    ],
    [
      "a nested change",
      { a: { b: [1, { c: 2 }] } },
      { a: { b: [1, { c: 3 }] } },
      false,
    ],
    ["an extra key", { a: 1 }, { a: 1, b: 2 }, false],
    [
      "a missing key of the same count",
      { a: 1, b: undefined },
      { a: 1, c: undefined },
      false,
    ],
    ["arrays of different length", [1], [1, 2], false],
    ["an array and an object", [1], { 0: 1 }, false],
    [
      "fresh React elements",
      createElement("b", { id: "x" }, "icon"),
      createElement("b", { id: "x" }, "icon"),
      true,
    ],
    [
      "React elements with other props",
      createElement("b", null, "a"),
      createElement("b", null, "b"),
      false,
    ],
    ["dates, by time", new Date(0), new Date(0), true],
    ["other dates", new Date(0), new Date(1), false],
    ["fresh functions, by identity", () => 1, () => 1, false],
    ["null and an object", null, {}, false],
  ])("%s", (_, a, b, same) => {
    expect(samePushValue(a, b)).toBe(same);
  });

  it("stops at a cyclic value", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    const b: Record<string, unknown> = {};
    b.self = b;
    expect(samePushValue(a, b)).toBe(false);
  });

  /** A binary DAG `levels` deep: each node's two keys hold the same child. */
  type Node = Record<string, unknown>;
  function dag(
    levels: number,
    leaf: unknown,
    wrap: (node: Node) => Node = (node) => node,
  ): Node {
    let node = wrap({ leaf });
    for (let i = 0; i < levels; i++) node = wrap({ l: node, r: node });
    return node;
  }

  it("reads each shared sub-object once, not once per path to it", () => {
    let reads = 0;
    const counted = (node: Node): Node =>
      new Proxy(node, {
        get(target, key, receiver) {
          reads++;
          return Reflect.get(target, key, receiver);
        },
      });
    // 2^18 paths reach the leaf; a walk per path reads millions of keys.
    expect(samePushValue(dag(18, 1, counted), dag(18, 1, counted))).toBe(true);
    expect(reads).toBeLessThan(500);
  });

  it("an equal DAG at the depth bound compares at once", () => {
    const started = performance.now();
    expect(samePushValue(dag(31, 1), dag(31, 1))).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("a change under a shared sub-object is a change", () => {
    expect(samePushValue(dag(24, 1), dag(24, 2))).toBe(false);
    // `a` shares one node where `b` has three, the last one different; the
    // padding walks past the pairs compared before any is remembered.
    const pad = () => Array.from({ length: 70 }, () => ({}));
    const shared = { v: 1 };
    expect(
      samePushValue(
        { pad: pad(), x: shared, y: shared, z: [shared] },
        { pad: pad(), x: { v: 1 }, y: { v: 1 }, z: [{ v: 2 }] },
      ),
    ).toBe(false);
  });

  it("a long equal trail, past the pairs it walks unremembered, is equal", () => {
    const trail = () =>
      Array.from({ length: 200 }, (_, i) => ({
        label: `c${i}`,
        content: createElement("b", null, `c${i}`),
      }));
    expect(samePushValue(trail(), trail())).toBe(true);
    const changed = trail();
    changed[150] = { label: "c150", content: createElement("b", null, "x") };
    expect(samePushValue(trail(), changed)).toBe(false);
  });
});

describe("withClientPushes", () => {
  it("puts each segment's client values after its server values, pushers in their order", () => {
    const owner1 = {};
    const owner2 = {};
    const pushes: ClientPushes = new Map([
      [
        "H",
        new Map([
          [
            "R0",
            new Map([
              [owner1, ["c1"]],
              [owner2, ["c2", "c3"]],
            ]),
          ],
          ["R0.@side", new Map([[owner1, ["s"]]])],
        ]),
      ],
    ]);
    const data = { H: { L0: ["l"], R0: ["r"] }, Other: { R0: ["o"] } };
    expect(withClientPushes(data, "H", pushes)).toEqual({
      H: { L0: ["l"], R0: ["r", "c1", "c2", "c3"], "R0.@side": ["s"] },
      Other: { R0: ["o"] },
    });
    // The server data is never written.
    expect(data.H.R0).toEqual(["r"]);
    expect(withClientPushes(data, "Other", pushes)).toBe(data);
  });
});

describe("EventController client handle layer", () => {
  afterEach(() => vi.restoreAllMocks());

  it("names the handle that changed; the hydration release names none", () => {
    const controller = createEventController();
    const listener = vi.fn();
    controller.subscribeToClientHandles(listener);
    controller.setClientHandle("H", "R0", {}, ["a"]);
    expect(listener).toHaveBeenLastCalledWith("H");
    controller.lockHydration();
    controller.setClientHandle("G", "R0", {}, ["b"]);
    controller.releaseHydrationLock();
    expect(listener).toHaveBeenLastCalledWith(undefined);
  });

  it("notifies on a change, not on equal values, and never writes the server state", () => {
    const controller = createEventController();
    controller.setHandleData({ H: { R0: ["server"] } }, ["R0"]);
    const listener = vi.fn();
    controller.subscribeToClientHandles(listener);
    const owner = {};
    controller.setClientHandle("H", "R0", owner, [{ a: { b: 1 } }]);
    controller.setClientHandle("H", "R0", owner, [{ a: { b: 1 } }]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(controller.getHandleState().data).toEqual({ H: { R0: ["server"] } });
    expect(
      controller.withClientHandles(controller.getHandleState().data, "H"),
    ).toEqual({ H: { R0: ["server", { a: { b: 1 } }] } });
    controller.setClientHandle("H", "R0", owner, []);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(
      controller.withClientHandles(controller.getHandleState().data, "H"),
    ).toEqual({ H: { R0: ["server"] } });
  });

  it("hides the layer and holds its notifications while the hydration window is open", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const controller = createEventController();
    controller.setHandleData({ H: { R0: ["server"] } }, ["R0", "R1"]);
    controller.lockHydration();
    const listener = vi.fn();
    controller.subscribeToClientHandles(listener);
    controller.setClientHandle("H", "R0", {}, ["client"]);
    expect(listener).not.toHaveBeenCalled();
    expect(
      controller.withClientHandles(controller.getHandleState().data, "H"),
    ).toEqual({ H: { R0: ["server"] } });
    controller.releaseHydrationLock();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(
      controller.withClientHandles(controller.getHandleState().data, "H"),
    ).toEqual({ H: { R0: ["server", "client"] } });
    // The server pushed into the client's segment: the server-then-client
    // pattern, no warning.
    expect(warn.mock.calls.map(String).join("\n")).not.toContain(
      "usePushHandle",
    );
  });

  it("warns at the hydration release when a client value lands in a segment the server pushed nothing into", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const controller = createEventController();
    controller.setHandleData({ H: { R0: ["server"] } }, ["R0", "R1"]);
    controller.lockHydration();
    controller.setClientHandle("H", "R1", {}, ["client"]);
    controller.releaseHydrationLock();
    expect(warn.mock.calls.map(String).join("\n")).toContain(
      'handle "H" shows a value only after hydration',
    );
  });

  it("keeps the server state shown over a held page from the first anchor until the page commits", () => {
    const controller = createEventController();
    controller.setHandleData({ H: { R0: ["one"] } }, ["R0"]);
    expect(controller.getHeldHandleState()).toBeUndefined();
    controller.flushRouteState("anchor");
    controller.setHandleData({ H: { R1: ["two"] } }, ["R1"]);
    controller.flushRouteState("anchor");
    expect(controller.getHeldHandleState()?.data).toEqual({
      H: { R0: ["one"] },
    });
    controller.releaseRouteState();
    expect(controller.getHeldHandleState()).toBeUndefined();
    controller.flushRouteState("anchor");
    controller.flushRouteState("release");
    expect(controller.getHeldHandleState()).toBeUndefined();
  });

  it("keeps one segment's pushers in the order they publish in from the resync a join asks for", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = createEventController();
    const resyncs: string[] = [];
    const owner = (name: string): ClientPushOwner => ({
      resync: () => void resyncs.push(name),
      generation: 0,
    });
    const a = owner("a");
    const b = owner("b");
    const at = (o: ClientPushOwner, generation: number): ClientPushOwner => {
      o.generation = generation;
      return o;
    };
    // b commits first; a, before it in the tree, joins later.
    controller.setClientHandle("H", "R0", at(b, 0), ["b"]);
    controller.setClientHandle("H", "R0", at(a, 0), ["a"]);
    expect(resyncs).toEqual(["b", "a"]);
    expect(controller.withClientHandles({}, "H")).toEqual({
      H: { R0: ["b", "a"] },
    });
    // A publish from before the resync's render moves nothing.
    controller.setClientHandle("H", "R0", at(b, 0), ["b"]);
    expect(controller.withClientHandles({}, "H")).toEqual({
      H: { R0: ["b", "a"] },
    });
    // The resync's commit, in tree order.
    controller.setClientHandle("H", "R0", at(a, 1), ["a"]);
    controller.setClientHandle("H", "R0", at(b, 1), ["b"]);
    expect(controller.withClientHandles({}, "H")).toEqual({
      H: { R0: ["a", "b"] },
    });
    // Later renders keep their place.
    controller.setClientHandle("H", "R0", at(a, 1), ["a2"]);
    expect(controller.withClientHandles({}, "H")).toEqual({
      H: { R0: ["a2", "b"] },
    });
    expect(error).not.toHaveBeenCalled();
  });
});
