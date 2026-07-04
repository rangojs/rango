/**
 * Type-level tests for parallel() slot handler contextual typing.
 *
 * Guards that a BARE arrow slot handler gets a typed ctx. Regression:
 * `parallel` was generic over the slots record
 * (`<TSlots extends Record<...>>(slots: TSlots)`), which made the object
 * literal an inference site and suppressed contextual typing, so `(ctx) => ...`
 * was an implicit any (TS7006 under noImplicitAny). The generic carried no
 * information (the return type is a plain ParallelItem), so it was dropped in
 * favor of a directly-typed parameter in BOTH DSLs
 * (src/urls/path-helper-types.ts and src/route-definition/helpers-types.ts).
 *
 * Known residual: in the urls() DSL a `{ handler, use }` DESCRIPTOR arrow still
 * needs an explicit ctx annotation. The slot union includes
 * StaticHandlerDefinition, whose own `.handler` property joins the contextual
 * property type for `handler` — two distinct callables, so TS declines to pick
 * a signature. Fixing it would mean renaming StaticHandlerDefinition.handler,
 * which is duck-typed across discovery/prerender/include-provider — not worth
 * it for a one-line annotation. The annotated form is pinned here instead.
 */

import { describe, it, expect, expectTypeOf } from "vitest";
import { urls } from "../urls.js";
import type { HandlerContext } from "../types/handler-context.js";

describe("parallel() slot handler contextual typing", () => {
  it("types ctx in bare slot handlers; annotated descriptor handlers keep their type", () => {
    const probe = () =>
      urls(({ layout, parallel }) => [
        layout(
          () => null,
          () => [
            parallel({
              "@bare": (ctx) => {
                expectTypeOf(ctx).not.toBeAny();
                expectTypeOf(ctx.reverse).toBeFunction();
                expectTypeOf(ctx.pathname).toEqualTypeOf<string>();
                return null;
              },
              "@descriptor": {
                handler: (ctx: HandlerContext) => {
                  expectTypeOf(ctx).not.toBeAny();
                  expectTypeOf(ctx.reverse).toBeFunction();
                  return null;
                },
              },
            }),
          ],
        ),
      ]);

    expect(typeof probe).toBe("function");
  });
});
