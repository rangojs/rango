import { describe, expect, it } from "vitest";
import {
  assertGeneratedRoutesMatch,
  diffGeneratedRoutes,
} from "@rangojs/router/testing";
import { router } from "../src/router.js";
import { NamedRoutes } from "../src/router.named-routes.gen.js";

// Whole-app generated-route drift. Mini has no Prerender, so the full router
// imports in a bare test. The primitive force-expands lazy include()d routes
// (here `/products` -> products.index/products.detail) before diffing, so the
// WHOLE-app check works in a unit test — added/removed/renamed routes and
// pattern drift are all caught.
describe("generated route drift (whole mini app)", () => {
  it("the committed NamedRoutes matches the full runtime route map (incl. includes)", () => {
    expect(() => assertGeneratedRoutesMatch(router, NamedRoutes)).not.toThrow();
  });

  it("diffGeneratedRoutes reports a clean diff after include expansion", () => {
    const diff = diffGeneratedRoutes(router, NamedRoutes);
    expect(diff.missing).toEqual([]); // lazy include()d routes now expanded
    expect(diff.extra).toEqual([]);
    expect(diff.mismatch).toEqual([]);
    expect(diff.ok).toBe(true);
  });

  it("the runtime map now contains the lazily-included routes", () => {
    expect(router.routeMap).toHaveProperty("products.index");
    expect(router.routeMap).toHaveProperty("products.detail");
  });

  it("catches REAL drift: a pattern mismatch is reported", () => {
    const diff = diffGeneratedRoutes(router, {
      ...NamedRoutes,
      "products.detail": "/products/:slug", // drifted (:id -> :slug)
    });
    expect(diff.ok).toBe(false);
    expect(diff.mismatch).toContainEqual([
      "products.detail",
      "/products/:slug",
      "/products/:id",
    ]);
  });

  it("catches REAL drift: a runtime-only route is reported as `extra`", () => {
    const { home: _omitted, ...withoutHome } = NamedRoutes;
    const diff = diffGeneratedRoutes(router, withoutHome);
    expect(diff.extra).toContain("home");
    expect(diff.ok).toBe(false);
  });
});
