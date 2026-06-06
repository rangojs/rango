// renderServerTree: real Flight serialize -> deserialize, returning an
// inspectable tree. Runs in the rsc project (react-server condition).
//
// The rsc project wires rangoUseClientTransform() (see vitest.rsc.config.ts),
// so a "use client" import is auto-registered as a boundary — renderServerTree
// resolves islands from the server tree's own imports, no clientComponents.
// The fixture is Counter.tsx (NOT Counter.client.tsx): "use client" is a
// directive, not a filename.
import { createElement, memo } from "react";
import { describe, expect, test } from "vitest";
import {
  assertFlightTreeRuntimeAvailable,
  findClientBoundaries,
  renderServerTree,
} from "../flight.entry.js";
import { Counter } from "./fixtures/Counter.js";
import { MemoBadge, RefInput } from "./fixtures/Badge.js";

describe("renderServerTree", () => {
  test("runtime is available", () => {
    expect(() => assertFlightTreeRuntimeAvailable()).not.toThrow();
  });

  test("pure server tree deserializes; no client boundaries", async () => {
    async function ServerOnly() {
      await Promise.resolve();
      return createElement(
        "main",
        { id: "root" },
        createElement("h1", null, "Hello Ada"),
      );
    }
    const { flight, tree } = await renderServerTree(createElement(ServerOnly));
    expect(flight).not.toContain("I[");
    expect(findClientBoundaries(tree)).toEqual([]);
    const json = JSON.stringify(tree);
    expect(json).toContain("Hello Ada");
    expect(json).toContain("root");
  });

  test("client island auto-discovered as an I-row (not inlined)", async () => {
    // No clientComponents: the transform registers Counter from its import.
    function Page() {
      return createElement(
        "main",
        null,
        createElement("h1", null, "Hello Ada"),
        createElement(Counter, {
          start: 5,
          when: new Date(0),
          tags: new Map([["a", 1]]),
        }),
      );
    }
    const { flight } = await renderServerTree(createElement(Page));
    // boundary preserved as an I-row...
    expect(flight).toContain("I[");
    expect(flight).toContain("Counter");
    // ...and the island's interactive guts are NOT inlined server-side.
    expect(flight).not.toContain("count:");
    expect(flight).toContain("Hello Ada");
  });

  test("typed prop fidelity across the boundary (async server component)", async () => {
    // async: the server component serializes as a deferred chunk, exercising the
    // lazy-materialization path in the tree walk.
    async function Page() {
      await Promise.resolve();
      return createElement(
        "div",
        null,
        createElement(Counter, {
          start: 5,
          when: new Date(0),
          tags: new Map([
            ["a", 1],
            ["b", 2],
          ]),
        }),
      );
    }
    const { tree } = await renderServerTree(createElement(Page));

    const [counter, ...rest] = findClientBoundaries(tree, "Counter");
    expect(rest).toHaveLength(0);
    expect(counter.name).toBe("Counter");
    // auto-discovery keys the boundary by module path.
    expect(counter.id).toContain("Counter.tsx");
    // The win: deserialized props are real JS values, not wire-encoded strings.
    expect(counter.props.start).toBe(5);
    expect(typeof counter.props.start).toBe("number");
    expect(counter.props.when).toBeInstanceOf(Date);
    expect((counter.props.when as Date).getTime()).toBe(0);
    expect(counter.props.tags).toBeInstanceOf(Map);
    expect((counter.props.tags as Map<string, number>).get("b")).toBe(2);
  });

  test("an unknown name yields an empty array", async () => {
    function Page() {
      return createElement(Counter, {
        start: 1,
        when: new Date(0),
        tags: new Map(),
      });
    }
    const { tree } = await renderServerTree(createElement(Page));
    expect(findClientBoundaries(tree, "Nope")).toEqual([]);
    expect(findClientBoundaries(tree)).toHaveLength(1);
  });

  test("findClientBoundaries returns every instance, in document order", async () => {
    const props = { start: 1, when: new Date(0), tags: new Map() };
    function Page() {
      return createElement(
        "ul",
        null,
        createElement(Counter, { ...props, start: 1 }),
        createElement(Counter, { ...props, start: 2 }),
      );
    }
    const { tree } = await renderServerTree(createElement(Page));
    const counters = findClientBoundaries(tree, "Counter");
    expect(counters).toHaveLength(2);
    expect(counters.map((b) => b.props.start)).toEqual([1, 2]);
    const [first] = counters;
    expect(first.props.start).toBe(1);
  });

  test("memo / forwardRef islands are auto-discovered (object exports)", async () => {
    // memo(...) and forwardRef(...) are objects at runtime; the transform must
    // still register them so they emit I-rows instead of being inlined.
    function Page() {
      return createElement(
        "div",
        null,
        createElement(MemoBadge, { count: 3 }),
        createElement(RefInput, { label: "Email" }),
      );
    }
    const { flight, tree } = await renderServerTree(createElement(Page));
    // not inlined: the rendered output of either island is absent.
    expect(flight).not.toContain("memo-badge");
    expect(flight).not.toContain("ref-input");
    const [memoBadge] = findClientBoundaries(tree, "MemoBadge");
    expect(memoBadge.props.count).toBe(3);
    const [refInput] = findClientBoundaries(tree, "RefInput");
    expect(refInput.props.label).toBe("Email");
  });

  test("clientComponents fallback registers a memo() object export", async () => {
    // A local memo component with no "use client" directive: the transform
    // ignores it, so clientComponents (registerOne) must still register the
    // OBJECT memo returns — a function-only check would skip it.
    const Widget = memo(function Widget(_props: { value: number }) {
      return createElement("span", null, "n/a");
    });
    function Page() {
      return createElement(Widget, { value: 42 });
    }
    const { tree } = await renderServerTree(createElement(Page), {
      clientComponents: { Widget },
    });
    const [widget] = findClientBoundaries(tree, "Widget");
    expect(widget.id).toBe("Widget");
    expect(widget.props.value).toBe(42);
  });
});
