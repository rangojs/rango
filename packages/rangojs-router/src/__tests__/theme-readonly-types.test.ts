import { describe, expectTypeOf, it } from "vitest";
import type { HandlerContext } from "../types.js";
import type { MiddlewareContext } from "../router/middleware-types.js";
import type { PublicRequestContext } from "../server/request-context.js";
import type { Theme } from "../theme/types.js";

// Pins #971: every public `theme` is a read-only getter guarded like
// cookies(). Assigning it throws at runtime (a getter with no setter), so it is
// a compile error. The @ts-expect-error lines are the coverage: if `readonly`
// regresses, the directive is unused and tsc fails.

describe("theme is read-only on every public context", () => {
  it("HandlerContext, MiddlewareContext and PublicRequestContext", () => {
    expectTypeOf<HandlerContext["theme"]>().toEqualTypeOf<Theme | undefined>();
    const assign = (
      handler: HandlerContext,
      middleware: MiddlewareContext,
      request: PublicRequestContext,
    ): void => {
      // @ts-expect-error theme is read-only
      handler.theme = "dark";
      // @ts-expect-error theme is read-only
      middleware.theme = "dark";
      // @ts-expect-error theme is read-only
      request.theme = "dark";
    };
    expectTypeOf(assign).toBeFunction();
  });
});
