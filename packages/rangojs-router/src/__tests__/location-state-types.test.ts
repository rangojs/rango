import { describe, it, expectTypeOf } from "vitest";
import type { ReactNode, ReactElement } from "react";
import { createLocationState } from "../browser/react/location-state-shared.js";

// Pins the location-state type contract: createLocationState only accepts values
// that survive history.state's structured clone. Plain serializable data is
// accepted and yields a usable definition; RSC content (ReactNode / JSX),
// functions, and symbols are a COMPILE error (the result is a non-callable
// LocationStateUnsafe brand) instead of a runtime DataCloneError.
//
// The @ts-expect-error lines are the coverage: if the guard regresses, the
// expected error disappears and tsc fails on the now-unused directive.

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
    // @ts-expect-error - RSC content cannot be posted to location state
    void createLocationState<ReactNode>()(null as ReactNode);
  });

  it("rejects posting a ReactElement (JSX)", () => {
    // @ts-expect-error - JSX cannot be posted to location state
    void createLocationState<ReactElement>()(null as unknown as ReactElement);
  });

  it("rejects posting a function", () => {
    // @ts-expect-error - functions cannot be posted to location state
    void createLocationState<() => void>()(() => {});
  });

  it("rejects posting a symbol", () => {
    // @ts-expect-error - symbols cannot be posted to location state
    void createLocationState<symbol>()(Symbol() as symbol);
  });

  it("rejects a nested ReactNode field", () => {
    // @ts-expect-error - RSC content cannot be nested in posted location state
    void createLocationState<{ title: string; body: ReactNode }>()({
      title: "x",
      body: null as ReactNode,
    });
  });

  it("rejects bare createLocationState() (unknown is not verifiable)", () => {
    // @ts-expect-error - unknown state cannot be verified serializable; supply a concrete type
    void createLocationState()(1);
  });

  it("rejects an `unknown` field", () => {
    // @ts-expect-error - an unknown field cannot be verified serializable
    void createLocationState<{ payload: unknown }>()({ payload: 1 });
  });

  it("rejects a class constructor", () => {
    class Foo {}
    // @ts-expect-error - class constructors cannot be posted to location state
    void createLocationState<typeof Foo>()(Foo);
  });
});
