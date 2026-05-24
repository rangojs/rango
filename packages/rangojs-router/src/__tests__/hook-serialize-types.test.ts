import { describe, it, expectTypeOf } from "vitest";
import { useFetchLoader, useLoader } from "../use-loader.js";
import { useHandle } from "../browser/react/use-handle.js";

// Pins the contract that the client data-read hooks apply Rango.FlightSerialize
// to their returns (so a revert of the wiring is caught). Flight preserves Date;
// an ordinary function cannot cross the boundary, so it surfaces as a `never`
// field — which is what distinguishes "wired" from "raw passthrough".

describe("hook return types apply FlightSerialize", () => {
  it("useLoader data is FlightSerialize<T>", () => {
    type Data = ReturnType<
      typeof useLoader<{ at: Date; n: number; fn: () => void }>
    >["data"];
    expectTypeOf<Data>().toEqualTypeOf<{ at: Date; n: number; fn: never }>();
  });

  it("useFetchLoader data is FlightSerialize<T> | undefined", () => {
    type Data = ReturnType<
      typeof useFetchLoader<{ at: Date; fn: () => void }>
    >["data"];
    expectTypeOf<Data>().toEqualTypeOf<{ at: Date; fn: never } | undefined>();
  });

  it("useHandle data is FlightSerialize<A>", () => {
    type Data = ReturnType<
      typeof useHandle<unknown, { at: Date; fn: () => void }>
    >;
    expectTypeOf<Data>().toEqualTypeOf<{ at: Date; fn: never }>();
  });
});
