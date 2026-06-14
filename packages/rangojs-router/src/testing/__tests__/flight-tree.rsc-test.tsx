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
  findElements,
  renderServerTree,
  textContent,
} from "../flight.entry.js";
import { Counter } from "./fixtures/Counter.js";
import { MemoBadge, RefInput } from "./fixtures/Badge.js";
import { createVar } from "../../context-var.js";
import { getRequestContext } from "../../server/request-context.js";

describe("renderServerTree", () => {
  test("runtime is available", () => {
    expect(() => assertFlightTreeRuntimeAvailable()).not.toThrow();
  });

  test("reclassifies the missing-rsc-alias stub error with actionable guidance", async () => {
    // renderServerTree shares serializeNodeToFlight with renderToFlightString, so
    // it self-diagnoses the missing-rangoTestAliases trap identically. Simulate
    // the stub by throwing its exact message from a server component.
    async function StubReader(): Promise<never> {
      await Promise.resolve();
      throw new Error(
        'getRequestContext() is only available from "@rangojs/router" in a ' +
          "react-server/RSC environment. For client hooks and components, import " +
          'from "@rangojs/router/client".',
      );
    }
    await expect(renderServerTree(<StubReader />)).rejects.toThrow(
      /rangoTestAliases/,
    );
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

  // #572 / #582 item: renderServerTree inherits the scoped `routeMap` option
  // (shared serializeToFlightString path), so ctx.reverse() resolves against the
  // provided map, not the order-dependent global route map.
  test("scopes ctx.reverse() to the provided routeMap option", async () => {
    async function ReverseEcho() {
      const ctx = getRequestContext();
      return <a href={ctx.reverse("product", { id: "7" })}>go</a>;
    }
    const { tree } = await renderServerTree(<ReverseEcho />, {
      routeMap: { product: "/scoped/products/:id" },
    });
    expect(JSON.stringify(tree)).toContain("/scoped/products/7");
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

  test("findClientBoundaries filters by testId / props / where (AND-ed)", async () => {
    const when = new Date(0);
    function Page() {
      return (
        <ul>
          <Counter start={1} when={when} tags={new Map()} data-testid="first" />
          <Counter
            start={2}
            when={when}
            tags={new Map()}
            data-testid="second"
          />
        </ul>
      );
    }
    const { tree } = await renderServerTree(<Page />);

    // by test id (a prop that crossed the boundary, not a server host attr).
    const [byTestId, ...others] = findClientBoundaries(tree, {
      testId: "second",
    });
    expect(others).toHaveLength(0);
    expect(byTestId.props.start).toBe(2);

    // props subset, deep-equal: a primitive prop...
    const [byStart] = findClientBoundaries(tree, { props: { start: 1 } });
    expect(byStart.props["data-testid"]).toBe("first");
    // ...and a Date prop, where Object.is would fail (two distinct instances).
    expect(
      findClientBoundaries(tree, { props: { when: new Date(0) } }),
    ).toHaveLength(2);

    // name + props AND-ed.
    expect(
      findClientBoundaries(tree, { name: "Counter", props: { start: 2 } }),
    ).toHaveLength(1);
    expect(
      findClientBoundaries(tree, { name: "Nope", props: { start: 2 } }),
    ).toEqual([]);

    // arbitrary predicate.
    const hot = findClientBoundaries(tree, {
      where: (b) => (b.props.start as number) >= 2,
    });
    expect(hot.map((b) => b.props.start)).toEqual([2]);

    // string form still matches by name (back-compat).
    expect(findClientBoundaries(tree, "Counter")).toHaveLength(2);
    // empty selector returns all.
    expect(findClientBoundaries(tree, {})).toHaveLength(2);
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
    expect(textContent(tree)).toBe("flag: true");
  });

  test("children are split out of props (boundary and host element alike)", async () => {
    function Page() {
      return (
        <section>
          <Counter start={1} when={new Date(0)} tags={new Map()}>
            inner text
          </Counter>
        </section>
      );
    }
    const { tree } = await renderServerTree(<Page />);

    const [counter] = findClientBoundaries(tree);
    expect(counter.props.children).toBeUndefined(); // not duplicated into props
    expect(counter.children).toBe("inner text"); // exposed separately, like FoundElement

    const [section] = findElements(tree, "section");
    expect(section.props.children).toBeUndefined();
    expect(section.children).toBeDefined(); // the nested Counter boundary
  });

  test("props selector deep-equals Set members by structure, not identity", async () => {
    const Tagged = (_props: { groups: Set<{ id: number }> }) => <span />;
    function Page() {
      return <Tagged groups={new Set([{ id: 1 }, { id: 2 }])} />;
    }
    const { tree } = await renderServerTree(<Page />, {
      clientComponents: { Tagged },
    });
    // distinct object instances of the same structure must still match.
    const [hit] = findClientBoundaries(tree, {
      props: { groups: new Set([{ id: 1 }, { id: 2 }]) },
    });
    expect(hit).toBeDefined();
    expect(
      findClientBoundaries(tree, { props: { groups: new Set([{ id: 9 }]) } }),
    ).toEqual([]);
  });

  test("findElements selects server/host elements (boundaries excluded)", async () => {
    async function Page() {
      await Promise.resolve();
      return (
        <article data-rank="1">
          <h1>Hello Ada</h1>
          <h2 data-testid="subtitle">Subtitle here</h2>
          <Counter start={5} when={new Date(0)} tags={new Map()} />
        </article>
      );
    }
    const { tree } = await renderServerTree(<Page />);

    // host elements only, in document order — the client boundary (Counter) is
    // NOT a host element and is excluded.
    expect(findElements(tree).map((e) => e.tag)).toEqual([
      "article",
      "h1",
      "h2",
    ]);
    expect(findClientBoundaries(tree)).toHaveLength(1); // Counter still findable

    // by tag (string form) + text content.
    const [h1] = findElements(tree, "h1");
    expect(h1.tag).toBe("h1");
    expect(h1.text).toBe("Hello Ada");

    // by data-testid on a HOST element (not a boundary prop).
    const [subtitle] = findElements(tree, { testId: "subtitle" });
    expect(subtitle.tag).toBe("h2");
    expect(textContent(subtitle.element)).toBe("Subtitle here");

    // by props subset.
    const [article] = findElements(tree, { props: { "data-rank": "1" } });
    expect(article.tag).toBe("article");

    // by text (substring and RegExp).
    expect(findElements(tree, { tag: "h2", text: "Subtitle" })).toHaveLength(1);
    expect(findElements(tree, { text: /Ada/ }).map((e) => e.tag)).toEqual([
      "article", // article's subtree contains "Hello Ada" too
      "h1",
    ]);

    // by predicate.
    expect(
      findElements(tree, { where: (e) => (e.tag ?? "").startsWith("h") }).map(
        (e) => e.tag,
      ),
    ).toEqual(["h1", "h2"]);

    // a boundary name is not a host tag -> no host-element match.
    expect(findElements(tree, "Counter")).toEqual([]);

    // textContent over the whole tree.
    expect(textContent(tree)).toContain("Hello Ada");
    expect(textContent(tree)).toContain("Subtitle here");
  });

  // Regression: the vendored client's readChunk transitions a deferred chunk
  // resolved_model -> fulfilled on the FIRST read. resolveServerLazy used to bail
  // on `fulfilled` and return the lazy wrapper, so a second encounter skipped the
  // subtree (textContent went "", a child host element under an
  // already-materialized parent reported text "").
  describe("async-server-component chunk resolution is idempotent", () => {
    test("textContent returns the same result on a second call", async () => {
      // The async child must be NESTED so its deferred chunk survives into the
      // tree (a top-level async tree is fully materialized by renderServerTree
      // itself, never re-reading a chunk). Reading text twice then re-reads the
      // same nested chunk — pre-fix the second read returned "".
      async function AsyncChild() {
        await Promise.resolve();
        return <em>async text</em>;
      }
      function Wrapper() {
        return (
          <section>
            <AsyncChild />
          </section>
        );
      }
      const { tree } = await renderServerTree(<Wrapper />);
      const first = textContent(tree);
      const second = textContent(tree);
      expect(first).toContain("async text");
      expect(second).toBe(first); // not "" on the second read
    });

    test("nested async child: article/p/em all report the text in ONE pass", async () => {
      // AsyncChild is an async server component (a deferred chunk). The parent
      // host elements materialize the shared chunk first; the child must still
      // report the async text in the SAME findElements walk.
      async function AsyncChild() {
        await Promise.resolve();
        return <em>async text</em>;
      }
      function Article() {
        return (
          <article>
            <p>
              <AsyncChild />
            </p>
          </article>
        );
      }
      const { tree } = await renderServerTree(<Article />);

      const elements = findElements(tree);
      const byTag = new Map(elements.map((e) => [e.tag, e]));
      expect(byTag.get("article")?.text).toContain("async text");
      expect(byTag.get("p")?.text).toContain("async text");
      expect(byTag.get("em")?.text).toContain("async text");

      // The { tag: "p", text: "async" } selector must match (pre-fix it silently
      // missed because the parent had already exhausted the chunk).
      expect(findElements(tree, { tag: "p", text: "async" })).toHaveLength(1);
    });
  });

  test("textContent counts a bigint leaf like a number", async () => {
    function Page() {
      return (
        <p>
          n=
          {9007199254740993n}
        </p>
      );
    }
    const { tree } = await renderServerTree(<Page />);
    expect(textContent(tree)).toContain("9007199254740993");
  });

  test("props selector deep-equal does not stack-overflow on a cyclic prop", async () => {
    // A cyclic object as a boundary prop: deepEqual must terminate (cycle guard)
    // rather than recurse to a RangeError.
    type Node = { id: number; self?: Node };
    const cyclic: Node = { id: 1 };
    cyclic.self = cyclic;
    const Widget = (_props: { node: Node }) => <span />;
    function Page() {
      return <Widget node={cyclic} />;
    }
    const { tree } = await renderServerTree(<Page />, {
      clientComponents: { Widget },
    });
    // The deserialized prop is its own cyclic structure; matching it against an
    // equivalently-cyclic query must not blow the stack.
    const query: Node = { id: 1 };
    query.self = query;
    expect(() =>
      findClientBoundaries(tree, { name: "Widget", props: { node: query } }),
    ).not.toThrow();
  });

  test("renderServerTree throws a migration error for the legacy { url } option", async () => {
    function Page() {
      return <p>hi</p>;
    }
    await expect(
      // @ts-expect-error legacy option removed; the runtime guard catches a
      // plain-JS / spread-defeated consumer still passing it.
      renderServerTree(<Page />, { url: "/legacy" }),
    ).rejects.toThrow(/`url` option was renamed to `request`/);
  });
});
