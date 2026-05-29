/**
 * Type-level tests for useParams overload resolution.
 *
 * Guards the three public call shapes so future refactors can't silently
 * regress back to the selector-only generic binding that broke
 * `useParams<T>()` ports from React Router / Next.js.
 *
 * Probes are never invoked at runtime — expectTypeOf only inspects their
 * inferred return types, so we exercise overload resolution without
 * needing a React context.
 */

import { describe, it, expectTypeOf } from "vitest";
import { useParams } from "../browser/react/use-params.js";

interface MailboxParams {
  mailboxId: string;
}

const defaultProbe = () => useParams();
const genericProbe = () => useParams<{ mailboxId: string }>();
const interfaceProbe = () => useParams<MailboxParams>();
const optionalGenericProbe = () => useParams<{ slug?: string }>();
const stringSelectorProbe = () => useParams((p) => p.productId);
const numberSelectorProbe = () => useParams((p) => p.productId?.length ?? 0);

describe("useParams types", () => {
  it("defaults to Readonly<Record<string, string | undefined>>", () => {
    // The default reflects the runtime: absent optional segments are
    // omitted from the params record, so untyped reads must surface as
    // `string | undefined`. Callers who know the shape pass an explicit
    // generic (see `genericProbe` below).
    expectTypeOf<ReturnType<typeof defaultProbe>>().toEqualTypeOf<
      Readonly<Record<string, string | undefined>>
    >();
  });

  it("binds the generic to the return shape without a selector", () => {
    expectTypeOf<ReturnType<typeof genericProbe>>().toEqualTypeOf<
      Readonly<{ mailboxId: string }>
    >();
  });

  it("accepts a named interface as the generic", () => {
    // Guards against the index-signature constraint regression:
    // interfaces don't get an implicit index signature, so a
    // `Record<string, string | undefined>` constraint would reject them.
    expectTypeOf<ReturnType<typeof interfaceProbe>>().toEqualTypeOf<
      Readonly<MailboxParams>
    >();
  });

  it("supports optional params in the generic", () => {
    expectTypeOf<ReturnType<typeof optionalGenericProbe>>().toEqualTypeOf<
      Readonly<{ slug?: string }>
    >();
  });

  it("infers selector return type", () => {
    // Selectors receive `Record<string, string | undefined>` so untyped
    // param reads are honest about the runtime — `p.productId` is
    // `string | undefined`. Callers who want a non-optional view should
    // narrow inside the selector or pass an explicit generic to
    // `useParams<T>()`.
    expectTypeOf<ReturnType<typeof stringSelectorProbe>>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<
      ReturnType<typeof numberSelectorProbe>
    >().toEqualTypeOf<number>();
  });

  it("rejects mutation of the returned params map", () => {
    type Params = ReturnType<typeof genericProbe>;
    const assign = (_p: Params) => {
      // @ts-expect-error — Readonly<T> blocks assignment
      _p.mailboxId = "next";
    };
    expectTypeOf(assign).toBeFunction();
  });
});
