import { describe, it, expectTypeOf } from "vitest";
import type { ReactNode } from "react";
import type { FlightSerialize, JsonSerialize } from "../serialize.js";

class Money {
  constructor(public cents: number) {}
  toJSON(): number {
    return this.cents;
  }
}

describe("JsonSerialize", () => {
  it("turns Date into string (via toJSON)", () => {
    expectTypeOf<JsonSerialize<Date>>().toEqualTypeOf<string>();
    expectTypeOf<JsonSerialize<{ createdAt: Date }>>().toEqualTypeOf<{
      createdAt: string;
    }>();
  });

  it("honors toJSON on custom classes (userland augmentation hook)", () => {
    expectTypeOf<JsonSerialize<Money>>().toEqualTypeOf<number>();
  });

  it("honors toJSON() that declares the JSON.stringify key parameter", () => {
    // JSON.stringify calls toJSON(key); a required key param must still match.
    class Stamped {
      toJSON(_key: string): { v: number } {
        return { v: 1 };
      }
    }
    expectTypeOf<JsonSerialize<Stamped>>().toEqualTypeOf<{ v: number }>();
  });

  it("recursively serializes toJSON() output (nested Date)", () => {
    class Period {
      toJSON(): { from: Date; to: Date } {
        return { from: new Date(), to: new Date() };
      }
    }
    expectTypeOf<JsonSerialize<Period>>().toEqualTypeOf<{
      from: string;
      to: string;
    }>();
  });

  it("honors toJSON() on nested fields and array elements", () => {
    expectTypeOf<
      JsonSerialize<{ price: Money; history: Money[] }>
    >().toEqualTypeOf<{ price: number; history: number[] }>();
  });

  it("drops function / symbol / undefined-valued keys", () => {
    expectTypeOf<
      JsonSerialize<{ a: string; f: () => void; s: symbol; u: undefined }>
    >().toEqualTypeOf<{ a: string }>();
  });

  it("preserves optional props and literal types", () => {
    expectTypeOf<JsonSerialize<{ tag: "ok"; n?: number }>>().toEqualTypeOf<{
      tag: "ok";
      n?: number;
    }>();
  });

  it("is identity on JSON-safe objects", () => {
    expectTypeOf<
      JsonSerialize<{ id: string; price: number; inStock: boolean }>
    >().toEqualTypeOf<{ id: string; price: number; inStock: boolean }>();
  });

  it("maps arrays element-wise (non-serializable -> null)", () => {
    expectTypeOf<JsonSerialize<Date[]>>().toEqualTypeOf<string[]>();
    expectTypeOf<JsonSerialize<[string, () => void]>>().toEqualTypeOf<
      [string, null]
    >();
  });

  it("collapses Map / Set to empty objects", () => {
    expectTypeOf<JsonSerialize<Map<string, number>>>().toEqualTypeOf<{}>();
    expectTypeOf<JsonSerialize<Set<number>>>().toEqualTypeOf<{}>();
  });

  it("treats bigint as throwing — never, propagated through containers", () => {
    // bigint makes JSON.stringify THROW (unlike undefined/functions, which are
    // omitted/nullified). So a bigint anywhere collapses the whole result to
    // never — the field must NOT be silently dropped to { name: string }.
    expectTypeOf<JsonSerialize<bigint>>().toEqualTypeOf<never>();
    expectTypeOf<
      JsonSerialize<{ id: bigint; name: string }>
    >().toEqualTypeOf<never>();
    expectTypeOf<JsonSerialize<bigint[]>>().toEqualTypeOf<never>();
    expectTypeOf<JsonSerialize<[string, bigint]>>().toEqualTypeOf<never>();
    expectTypeOf<
      JsonSerialize<{ nested: { value: bigint } }>
    >().toEqualTypeOf<never>();
  });

  it("recurses nested objects and arrays", () => {
    expectTypeOf<
      JsonSerialize<{ items: { at: Date; qty: number }[] }>
    >().toEqualTypeOf<{ items: { at: string; qty: number }[] }>();
  });
});

describe("FlightSerialize", () => {
  it("preserves primitives incl. bigint and symbol, and Date (NOT string)", () => {
    expectTypeOf<FlightSerialize<Date>>().toEqualTypeOf<Date>();
    expectTypeOf<FlightSerialize<bigint>>().toEqualTypeOf<bigint>();
    expectTypeOf<FlightSerialize<symbol>>().toEqualTypeOf<symbol>();
    expectTypeOf<FlightSerialize<{ at: Date; n: number }>>().toEqualTypeOf<{
      at: Date;
      n: number;
    }>();
  });

  it("preserves Map / Set / typed arrays / Promise (recursing element types)", () => {
    expectTypeOf<FlightSerialize<Map<string, Date>>>().toEqualTypeOf<
      Map<string, Date>
    >();
    expectTypeOf<FlightSerialize<Set<number>>>().toEqualTypeOf<Set<number>>();
    expectTypeOf<FlightSerialize<Uint8Array>>().toEqualTypeOf<Uint8Array>();
    expectTypeOf<FlightSerialize<Promise<Date>>>().toEqualTypeOf<
      Promise<Date>
    >();
  });

  it("preserves array/tuple shape and keeps Date elements", () => {
    expectTypeOf<FlightSerialize<Date[]>>().toEqualTypeOf<Date[]>();
  });

  it("resolves ordinary functions to never (kept as a never field, not dropped)", () => {
    expectTypeOf<FlightSerialize<() => void>>().toEqualTypeOf<never>();
    expectTypeOf<
      FlightSerialize<{ at: Date; f: () => void; s: symbol }>
    >().toEqualTypeOf<{ at: Date; f: never; s: symbol }>();
  });

  it("preserves a bare ReactNode identically (Flight keeps JSX)", () => {
    // The non-distributive `[T] extends [ReactNode]` leaf preserves the whole
    // ReactNode union as-is instead of splitting it.
    expectTypeOf<FlightSerialize<ReactNode>>().toEqualTypeOf<ReactNode>();
    // A plain ReactNode field round-trips too.
    expectTypeOf<FlightSerialize<{ node: ReactNode }>>().toEqualTypeOf<{
      node: ReactNode;
    }>();
  });

  it("preserves the async-node union (ReactNode | Promise<ReactNode>) identically", () => {
    // The leaf covers `ReactNode | Promise<ReactNode>` as a whole, so a handle
    // like Breadcrumbs (`content?: ReactNode | Promise<ReactNode>`) round-trips
    // unchanged — safe to wrap a useHandle/useLoader return in FlightSerialize.
    type Crumb = {
      label: string;
      content?: ReactNode | Promise<ReactNode>;
    };
    expectTypeOf<FlightSerialize<Crumb>>().toEqualTypeOf<Crumb>();
    expectTypeOf<FlightSerialize<Crumb[]>>().toEqualTypeOf<Crumb[]>();
  });
});
