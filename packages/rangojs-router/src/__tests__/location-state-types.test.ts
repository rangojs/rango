import { describe, it, expectTypeOf } from "vitest";
import type { ReactNode, ReactElement } from "react";
import {
  createLocationState,
  type LocationStateEntry,
  type LocationStateGuard,
  type LocationStateOptions,
  type LocationStateUnsafe,
  type ValidateLocationState,
} from "../browser/react/location-state-shared.js";
import type {
  HistoryState,
  PlainHistoryState,
  RouterNavigateOptions,
} from "../browser/types.js";
import type { LinkState } from "../browser/react/Link.js";
import { withLocationStateKey } from "../testing/location-state-key.js";

// Pins the location-state type contract: createLocationState only accepts values
// that survive history.state's structured clone. Plain serializable data is
// accepted and yields a usable definition; RSC content (ReactNode / JSX),
// functions, and symbols are a COMPILE error (the result is a non-callable
// LocationStateUnsafe brand) instead of a runtime DataCloneError.
//
// The @ts-expect-error lines are the coverage: if the guard regresses, the
// expected error disappears and tsc fails on the now-unused directive.
//
// Definitions are keyed with withLocationStateKey: the calls below also run,
// and an unkeyed definition throws outside production.

describe("createLocationState type safety", () => {
  it("accepts plain serializable data and yields a usable definition", () => {
    const Product = createLocationState<{ name: string; price: number }>();
    // It is a real definition (callable + .read returns the typed state).
    expectTypeOf(Product).toBeCallableWith({ name: "Widget", price: 9.99 });
    expectTypeOf(Product.read()).toEqualTypeOf<
      { name: string; price: number } | undefined
    >();
  });

  it("accepts primitives, arrays, optional fields, and structured-clone built-ins", () => {
    expectTypeOf(createLocationState<string>().read()).toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf(
      createLocationState<{ items: string[] }>().read(),
    ).toEqualTypeOf<{ items: string[] } | undefined>();
    expectTypeOf(
      createLocationState<{ from?: string; count?: number }>().read(),
    ).toEqualTypeOf<{ from?: string; count?: number } | undefined>();
    expectTypeOf(createLocationState<{ at: Date }>().read()).toEqualTypeOf<
      { at: Date } | undefined
    >();
    expectTypeOf(
      createLocationState<{ tags: Set<string> }>().read(),
    ).toEqualTypeOf<{ tags: Set<string> } | undefined>();
  });

  it("rejects posting a ReactNode (RSC content)", () => {
    const State = withLocationStateKey(createLocationState<ReactNode>());
    // @ts-expect-error - RSC content cannot be posted to location state
    void State(null as ReactNode);
  });

  it("rejects posting a ReactElement (JSX)", () => {
    const State = withLocationStateKey(createLocationState<ReactElement>());
    // @ts-expect-error - JSX cannot be posted to location state
    void State(null as unknown as ReactElement);
  });

  it("rejects posting a function", () => {
    const State = withLocationStateKey(createLocationState<() => void>());
    // @ts-expect-error - functions cannot be posted to location state
    void State(() => {});
  });

  it("rejects posting a symbol", () => {
    const State = withLocationStateKey(createLocationState<symbol>());
    // @ts-expect-error - symbols cannot be posted to location state
    void State(Symbol() as symbol);
  });

  it("rejects a nested ReactNode field", () => {
    const State = withLocationStateKey(
      createLocationState<{ title: string; body: ReactNode }>(),
    );
    // @ts-expect-error - RSC content cannot be nested in posted location state
    void State({ title: "x", body: null as ReactNode });
  });

  it("rejects bare createLocationState() (unknown is not verifiable)", () => {
    const State = withLocationStateKey(createLocationState());
    // @ts-expect-error - unknown state cannot be verified serializable; supply a concrete type
    void State(1);
  });

  it("rejects an `unknown` field", () => {
    const State = withLocationStateKey(
      createLocationState<{ payload: unknown }>(),
    );
    // @ts-expect-error - an unknown field cannot be verified serializable
    void State({ payload: 1 });
  });

  it("rejects a class constructor", () => {
    class Foo {}
    const State = withLocationStateKey(createLocationState<typeof Foo>());
    // @ts-expect-error - class constructors cannot be posted to location state
    void State(Foo);
  });
});

// The compile error names the offending field: ValidateLocationState carries
// the reason AND the path in the LocationStateUnsafe brand, which TypeScript
// prints in the "not assignable to parameter of type" message.
describe("ValidateLocationState names the failing field", () => {
  interface Row {
    id: string;
    info: { label: string; values: unknown };
  }
  interface ListState {
    items: Row[];
    cursor: string;
  }

  it("is `unknown` (a no-op) for a safe value", () => {
    expectTypeOf<
      ValidateLocationState<{ a: string; at: Date }>
    >().toEqualTypeOf<unknown>();
  });

  it("carries the path of an `unknown` field reached through an array", () => {
    expectTypeOf<ValidateLocationState<ListState>>().toEqualTypeOf<
      LocationStateUnsafe<
        "`unknown` cannot be verified as serializable; give it a concrete type",
        "items[].info.values"
      >
    >();
    const List = withLocationStateKey(createLocationState<ListState>());
    // @ts-expect-error - LocationStateUnsafe<"`unknown` cannot be verified ...", "items[].info.values">
    void List({ items: [], cursor: "c1" });
  });

  it("names every failing path, with the reason for each", () => {
    expectTypeOf<
      ValidateLocationState<{
        tags: Set<symbol>;
        byId: Map<string, { body: ReactElement }>;
      }>
    >().toEqualTypeOf<
      | LocationStateUnsafe<
          "symbols cannot be stored in location state",
          "tags[]"
        >
      | LocationStateUnsafe<
          "React/RSC content cannot be stored in location state; store plain data and render it on arrival",
          "byId<value>.body"
        >
    >();
  });

  it("reports an object's own unsafe fields before anything nested deeper", () => {
    expectTypeOf<
      ValidateLocationState<{
        onPick: () => void;
        nested: { body: ReactElement };
      }>
    >().toEqualTypeOf<
      LocationStateUnsafe<
        "functions cannot be stored in location state",
        "onPick"
      >
    >();
  });

  it("reports `<root>` when the value itself is unsafe", () => {
    expectTypeOf<ValidateLocationState<() => void>>().toEqualTypeOf<
      LocationStateUnsafe<
        "functions cannot be stored in location state",
        "<root>"
      >
    >();
  });

  // Walking a DOM node's whole object graph took 8.4M instantiations and hit
  // TS2589; stopping at its methods keeps it cheap and still names the field.
  it("stops at a DOM node's methods instead of walking its object graph", () => {
    expectTypeOf<
      LocationStateUnsafe<
        "functions cannot be stored in location state",
        "row.el.click"
      >
    >().toExtend<ValidateLocationState<{ row: { el: HTMLElement } }>>();
  });

  it("stops at depth 8 and accepts a safe recursive type", () => {
    type Deep = {
      a: { b: { c: { d: { e: { f: { g: { h: { i: () => void } } } } } } } };
    };
    expectTypeOf<ValidateLocationState<Deep>>().toEqualTypeOf<
      LocationStateUnsafe<
        "nested too deep to locate the unsafe field; it is below this path",
        "a.b.c.d.e.f.g.h"
      >
    >();
    type Tree = { name: string; children: Tree[]; onOpen?: () => void };
    expectTypeOf<ValidateLocationState<Tree>>().toEqualTypeOf<
      LocationStateUnsafe<
        "functions cannot be stored in location state",
        "onOpen"
      >
    >();
    type SafeTree = { name: string; children: SafeTree[] };
    expectTypeOf<ValidateLocationState<SafeTree>>().toEqualTypeOf<unknown>();
  });

  // An `any` field passes LocationStateSafe but read as an own unsafe field,
  // so the walk reported only it (nothing) and fell back to the generic reason.
  it("does not let an `any` field hide a failing sibling's path", () => {
    expectTypeOf<
      ValidateLocationState<{ loose: any; nested: { onPick: () => void } }>
    >().toEqualTypeOf<
      LocationStateUnsafe<
        "functions cannot be stored in location state",
        "nested.onPick"
      >
    >();
  });

  it("prints index signatures as [string] and keeps tuple indices", () => {
    expectTypeOf<
      ValidateLocationState<{ payload: { data: Record<string, () => void> } }>
    >().toEqualTypeOf<
      LocationStateUnsafe<
        "functions cannot be stored in location state",
        "payload.data[string]"
      >
    >();
    expectTypeOf<
      ValidateLocationState<{ pair: [string, { onPick: () => void }] }>
    >().toEqualTypeOf<
      LocationStateUnsafe<
        "functions cannot be stored in location state",
        "pair[1].onPick"
      >
    >();
  });
});

// `state` on push/replace/Link: typed entries go in an array; a bare entry or
// an uncalled definition is a compile error (issue #993).
describe("navigation state typing", () => {
  const GridState = withLocationStateKey(
    createLocationState<{ count: number }>(),
    "GridState",
  );
  interface Filters {
    q: string;
    page: number;
  }

  it("keeps HistoryState a real union (not `unknown`)", () => {
    expectTypeOf<unknown>().not.toExtend<HistoryState>();
    expectTypeOf<RouterNavigateOptions["state"]>().toEqualTypeOf<
      HistoryState | undefined
    >();
  });

  it("accepts typed entries in an array and plain structured-clone data", () => {
    const filters: Filters = { q: "wine", page: 2 };
    const record: Record<string, unknown> = { from: "list" };
    const accepted: RouterNavigateOptions[] = [
      { state: [GridState({ count: 3 })] },
      { state: [GridState(() => ({ count: 3 }))] },
      { state: [] },
      { state: { from: "list", count: 5 } },
      { state: filters },
      { state: record },
      { state: "list" },
      { state: 42 },
      { state: null },
      { state: [1, "a", { nested: true }] },
      { state: new Date() },
      { state: new Map([["a", 1]]) },
      { state: new Set(["a"]) },
      { state: new Uint8Array(2) },
      { state: new ArrayBuffer(2) },
      { state: new Blob([]) },
    ];
    expectTypeOf(accepted).toEqualTypeOf<RouterNavigateOptions[]>();
    expectTypeOf(filters).toExtend<PlainHistoryState>();
  });

  it("accepts a readonly entry array (e.g. `as const`)", () => {
    expectTypeOf<readonly LocationStateEntry[]>().toExtend<HistoryState>();
    const entries = [GridState({ count: 3 })] as const;
    const options: RouterNavigateOptions = { state: entries };
    void options;
    expectTypeOf<readonly LocationStateEntry[]>().toExtend<LinkState>();
  });

  // Not structured-cloneable, and caught without walking plain objects:
  // Promise, WeakMap, and WeakSet carry Symbol.toStringTag.
  it("rejects a Promise, WeakMap, or WeakSet as top-level state", () => {
    expectTypeOf<Promise<{ from: string }>>().not.toExtend<HistoryState>();
    expectTypeOf<WeakMap<object, string>>().not.toExtend<HistoryState>();
    expectTypeOf<WeakSet<object>>().not.toExtend<HistoryState>();
  });

  it("rejects a typed entry passed without the array", () => {
    // @ts-expect-error - a single entry is not HistoryState; wrap it: [GridState(value)]
    const options: RouterNavigateOptions = { state: GridState({ count: 3 }) };
    void options;
  });

  it("rejects a definition passed without calling it", () => {
    // @ts-expect-error - a definition is not an entry; call it: [GridState(value)]
    const options: RouterNavigateOptions = { state: [GridState] };
    void options;
    // @ts-expect-error - a bare definition is a function, not state
    const bare: RouterNavigateOptions = { state: GridState };
    void bare;
  });

  it("rejects functions and a mixed typed/plain array", () => {
    // @ts-expect-error - functions throw DataCloneError in history.pushState
    const fn: RouterNavigateOptions = { state: () => ({ from: "list" }) };
    void fn;
    const mixed: RouterNavigateOptions = {
      // @ts-expect-error - a plain value cannot sit next to typed entries
      state: [GridState({ count: 1 }), { from: "list" }],
    };
    void mixed;
    const untyped: unknown = { from: "list" };
    // @ts-expect-error - `unknown` state must be narrowed (PlainHistoryState)
    const loose: RouterNavigateOptions = { state: untyped };
    void loose;
  });

  it("applies the same typing to <Link state>, plus a click-time getter", () => {
    expectTypeOf<[ReturnType<typeof GridState>]>().toExtend<LinkState>();
    expectTypeOf<{ from: string }>().toExtend<LinkState>();
    expectTypeOf<() => { from: string }>().toExtend<LinkState>();
    expectTypeOf<ReturnType<typeof GridState>>().not.toExtend<LinkState>();
    expectTypeOf<(typeof GridState)[]>().not.toExtend<LinkState>();
    expectTypeOf<typeof GridState>().not.toExtend<LinkState>();
  });
});

describe("createLocationState options typing", () => {
  type Grid = { count: number };
  const isGrid = (value: unknown): value is Grid =>
    typeof (value as Grid | null)?.count === "number";

  it("LocationStateOptions is one interface: every option optional, and extendable", () => {
    // An interface can only extend an object type, not a union.
    interface GridOptions extends LocationStateOptions<Grid> {
      label?: string;
    }
    const options: GridOptions = {
      flash: false,
      clearOnReload: true,
      validate: isGrid,
      label: "grid",
    };
    expectTypeOf(createLocationState<Grid>(options).read()).toEqualTypeOf<
      Grid | undefined
    >();
    expectTypeOf<LocationStateOptions>().toEqualTypeOf<
      LocationStateOptions<unknown>
    >();
  });

  it("validate is a LocationStateGuard: a type predicate, not a boolean function", () => {
    expectTypeOf(isGrid).toExtend<LocationStateGuard<Grid>>();
    expectTypeOf<
      NonNullable<LocationStateOptions<Grid>["validate"]>
    >().toEqualTypeOf<LocationStateGuard<Grid>>();
    const loose: LocationStateOptions<Grid> = {
      // @ts-expect-error - a boolean-returning check does not narrow to Grid
      validate: (value: unknown): boolean => value !== null,
    };
    void loose;
  });

  it("has no version option: state is versioned by the app version", () => {
    expectTypeOf<keyof LocationStateOptions>().toEqualTypeOf<
      "flash" | "clearOnReload" | "validate"
    >();
    // @ts-expect-error - not an option
    createLocationState<Grid>({ version: 2 });
  });
});
