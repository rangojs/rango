// renderServerTree: real Flight serialize -> deserialize, returning an
// inspectable tree. Runs in the rsc project (react-server condition).
//
// The rsc project wires rangoUseClientTransform() (see vitest.rsc.config.ts),
// so a "use client" import is auto-registered as a boundary — renderServerTree
// resolves islands from the server tree's own imports, no clientComponents.
// The fixture is Counter.tsx (NOT Counter.client.tsx): "use client" is a
// directive, not a filename.
import { memo } from "react";
import { describe, expect, test } from "vitest";
import {
  assertFlightTreeRuntimeAvailable,
  findClientBoundaries,
  renderServerTree,
} from "../flight.entry.js";
import { Counter } from "./fixtures/Counter.js";
import { MemoBadge, RefInput } from "./fixtures/Badge.js";
import { createVar } from "../../context-var.js";
import { getRequestContext } from "../../server/request-context.js";

describe("renderServerTree", () => {
  test("runtime is available", () => {
    expect(() => assertFlightTreeRuntimeAvailable()).not.toThrow();
  });

  test("pure server tree deserializes; no client boundaries", async () => {
    async function ServerOnly() {
      await Promise.resolve();
      return (
        <main id="root">
          <h1>Hello Ada</h1>
        </main>
      );
    }
    const { flight, tree } = await renderServerTree(<ServerOnly />);
    expect(flight).not.toContain("I[");
    expect(findClientBoundaries(tree)).toEqual([]);
    const json = JSON.stringify(tree);
    expect(json).toContain("Hello Ada");
    expect(json).toContain("root");
  });

  test("client island auto-discovered as an I-row (not inlined)", async () => {
    // No clientComponents: the transform registers Counter from its import.
    function Page() {
      return (
        <main>
          <h1>Hello Ada</h1>
          <Counter start={5} when={new Date(0)} tags={new Map([["a", 1]])} />
        </main>
      );
    }
    const { flight } = await renderServerTree(<Page />);
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
      return (
        <div>
          <Counter
            start={5}
            when={new Date(0)}
            tags={
              new Map([
                ["a", 1],
                ["b", 2],
              ])
            }
          />
        </div>
      );
    }
    const { tree } = await renderServerTree(<Page />);

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
      return <Counter start={1} when={new Date(0)} tags={new Map()} />;
    }
    const { tree } = await renderServerTree(<Page />);
    expect(findClientBoundaries(tree, "Nope")).toEqual([]);
    expect(findClientBoundaries(tree)).toHaveLength(1);
  });

  test("findClientBoundaries returns every instance, in document order", async () => {
    const when = new Date(0);
    function Page() {
      return (
        <ul>
          <Counter start={1} when={when} tags={new Map()} />
          <Counter start={2} when={when} tags={new Map()} />
        </ul>
      );
    }
    const { tree } = await renderServerTree(<Page />);
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
      return (
        <div>
          <MemoBadge count={3} />
          <RefInput label="Email" />
        </div>
      );
    }
    const { flight, tree } = await renderServerTree(<Page />);
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
      return <span>n/a</span>;
    });
    function Page() {
      return <Widget value={42} />;
    }
    const { tree } = await renderServerTree(<Page />, {
      clientComponents: { Widget },
    });
    const [widget] = findClientBoundaries(tree, "Widget");
    expect(widget.id).toBe("Widget");
    expect(widget.props.value).toBe(42);
  });

  test("a server component reading getRequestContext() during render sees seeded vars", async () => {
    // renderServerTree renders an ELEMENT; a server component inside it can read
    // getRequestContext() during render, and `vars` seeds ctx.get(MyVar).
    const Flag = createVar<boolean>();
    async function Banner() {
      return <p>{`flag: ${String(getRequestContext().get(Flag))}`}</p>;
    }
    const { tree } = await renderServerTree(<Banner />, {
      vars: [[Flag, true]],
    });
    expect(JSON.stringify(tree)).toContain("flag: true");
  });
});
