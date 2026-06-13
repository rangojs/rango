/**
 * Type-level tests for the router.use() pattern-generic overload.
 *
 * Guards that `.use("/users/:id", mw)` types `ctx.params` from the pattern
 * (ExtractParams), while the bare `.use(mw)` form stays generic. The probes are
 * never invoked at runtime — their bodies are type-checked by tsc (the package
 * typecheck gate enforces the expectTypeOf assertions), so we exercise overload
 * resolution and contextual typing without constructing a real router.
 */

import { describe, it, expect, expectTypeOf } from "vitest";
import type { Rango } from "../router/router-interfaces.js";

describe("router.use() pattern overload types", () => {
  it("types ctx.params from the pattern; bare use() stays generic", () => {
    const probe = (router: Rango<{ DB: string }, Record<string, string>>) => {
      // Named param: ctx.params.id is known-present.
      router.use("/users/:id", (ctx) => {
        expectTypeOf(ctx.params).toEqualTypeOf<{ id: string }>();
      });

      // Optional + required params.
      router.use("/:locale?/blog/:slug", (ctx) => {
        expectTypeOf(ctx.params).toEqualTypeOf<{
          locale?: string;
          slug: string;
        }>();
      });

      // Bare middleware (no pattern) keeps the generic params record.
      router.use((ctx) => {
        expectTypeOf(ctx.params).toEqualTypeOf<
          Record<string, string | undefined>
        >();
      });
    };

    expect(typeof probe).toBe("function");
  });
});
