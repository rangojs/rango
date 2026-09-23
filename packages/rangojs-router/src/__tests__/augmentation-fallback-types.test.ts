/**
 * Type-level tests for the UNAUGMENTED Rango fallbacks.
 *
 * This file runs in the main program, where nothing augments Rango, so it
 * pins the fallback behavior:
 * - `ctx.env` falls back to `unknown` (not `any`) when Rango.Env is unaugmented.
 * - `href()` stays permissive when neither RegisteredRoutes nor GeneratedRouteMap
 *   is registered.
 * - Response-route and middleware `ctx.reverse` accept any global name but
 *   still reject a dot-local literal (they have no include() scope).
 *
 * The augmented counterpart lives in src/__augment-tests__ (separate tsconfig) so
 * its global augmentation does not leak into these assertions.
 */
import { describe, it, expectTypeOf } from "vitest";
import type {
  Handler,
  MiddlewareContext,
  ResponseHandlerContext,
} from "../index.js";
import { href } from "../href-client.js";

describe("unaugmented Rango fallbacks", () => {
  it("ctx.env is `unknown` (not `any`) when Rango.Env is unaugmented", () => {
    const handler: Handler<"/items/:id"> = (ctx) => {
      expectTypeOf(ctx.env).toBeUnknown();
      return null;
    };
    void handler;
  });

  it("href stays permissive when no routes are registered", () => {
    // No RegisteredRoutes and no GeneratedRouteMap in this program, so ValidPaths
    // collapses to a permissive string and any path is accepted.
    href("/anything-goes");
    href("/deeply/nested/path?with=query#hash");
  });

  it("response-route and middleware ctx.reverse reject dot-local names", () => {
    // Never invoked: the calls are compile-time assertions.
    const response = (ctx: ResponseHandlerContext): void => {
      expectTypeOf(ctx.reverse("api.health")).toBeString();
      const dynamicName: string = "api.health";
      expectTypeOf(ctx.reverse(dynamicName)).toBeString();
      // @ts-expect-error - dot-local name; no include() scope to resolve it
      ctx.reverse(".sibling");
    };
    const middleware = (ctx: MiddlewareContext): void => {
      expectTypeOf(ctx.reverse("api.item", { id: "42" })).toBeString();
      // @ts-expect-error - dot-local name; no include() scope to resolve it
      ctx.reverse(".sibling");
    };
    void response;
    void middleware;
  });
});
