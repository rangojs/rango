/**
 * Type-level tests for the UNAUGMENTED Rango fallbacks.
 *
 * This file runs in the main program, where nothing augments Rango, so it
 * pins the fallback behavior:
 * - `ctx.env` falls back to `unknown` (not `any`) when Rango.Env is unaugmented.
 * - `href()` stays permissive when neither RegisteredRoutes nor GeneratedRouteMap
 *   is registered.
 *
 * The augmented counterpart lives in src/__augment-tests__ (separate tsconfig) so
 * its global augmentation does not leak into these assertions.
 */
import { describe, it, expectTypeOf } from "vitest";
import type { Handler } from "../index.js";
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
});
