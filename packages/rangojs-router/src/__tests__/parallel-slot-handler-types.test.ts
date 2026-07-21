/**
 * Type-level tests for parallel() slot handler contextual typing.
 *
 * Guards that bare and descriptor arrow slot handlers get a typed ctx. The
 * first regression was that `parallel` was generic over the slots record
 * (`<TSlots extends Record<...>>(slots: TSlots)`), which made the object
 * literal an inference site and suppressed contextual typing, so `(ctx) => ...`
 * was an implicit any (TS7006 under noImplicitAny). The generic carried no
 * information (the return type is a plain ParallelItem), so it was dropped in
 * favor of a directly-typed parameter in both DSLs. The second regression was
 * that `StaticHandlerDefinition.handler` joined the descriptor's contextual
 * `handler` union as a different callable signature, making descriptor `ctx`
 * implicit any. Parallel slot types now use a handler-less static reference
 * with a REQUIRED type-only brand: Static() definitions are assignable (the
 * definition interface declares the brand) while arbitrary objects — including
 * `{}`, which an optional brand would admit via weak-type checking — stay
 * compile errors instead of render-time invalid-React-child crashes.
 */

import { describe, it, expect, expectTypeOf } from "vitest";
import { urls } from "../urls.js";
import { createRouteHelpers } from "../route-definition/helper-factories.js";
import { Static } from "../static-handler.js";
import type { StaticHandlerRef } from "../static-handler.js";

interface TestEnv {
  value: string;
}

type AssertNever<T extends never> = T;
type AssertFalse<T extends false> = T;
type _StaticRefExposesNoStringKeys = AssertNever<
  Extract<keyof StaticHandlerRef, string>
>;
type _StaticRefRejectsUnrelatedObjects = AssertFalse<
  { unrelated: true } extends StaticHandlerRef ? true : false
>;
type _StaticRefRejectsEmptyObjects = AssertFalse<
  Record<never, never> extends StaticHandlerRef ? true : false
>;

describe("parallel() slot handler contextual typing", () => {
  it("types ctx in bare and descriptor slot handlers in urls()", () => {
    const staticSlot = Static(() => null);
    const probe = () =>
      urls<TestEnv>(({ layout, parallel, revalidate }) => [
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
                handler: (ctx) => {
                  expectTypeOf(ctx).not.toBeAny();
                  expectTypeOf(ctx.reverse).toBeFunction();
                  expectTypeOf(ctx.env).toEqualTypeOf<TestEnv>();
                  return null;
                },
                use: () => [revalidate(() => true)],
              },
              "@static": staticSlot,
              "@static-descriptor": { handler: staticSlot },
              // @ts-expect-error — {} is not a valid slot value
              "@empty": {},
              // @ts-expect-error — {} is not a valid descriptor handler
              "@empty-descriptor": { handler: {} },
            }),
          ],
        ),
      ]);

    expect(typeof probe).toBe("function");
  });

  it("keeps the route-definition helper seam aligned", () => {
    const staticSlot = Static(() => null);
    const probe = () => {
      const { parallel } = createRouteHelpers<any, TestEnv>();
      return parallel({
        "@descriptor": {
          handler: (ctx) => {
            expectTypeOf(ctx).not.toBeAny();
            expectTypeOf(ctx.env).toEqualTypeOf<TestEnv>();
            return null;
          },
        },
        "@static": staticSlot,
        "@static-descriptor": { handler: staticSlot },
        // @ts-expect-error — {} is not a valid slot value
        "@empty": {},
      });
    };

    expect(typeof probe).toBe("function");
  });
});
