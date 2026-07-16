import { describe, expect, it } from "vitest";
import {
  assertGeneratedRoutesMatch,
  diffGeneratedRoutes,
} from "@rangojs/router/testing";
import { createRouter } from "@rangojs/router";
import { apiPatterns } from "../src/api/urls.js";
import { NamedRoutes } from "../src/router.named-routes.gen.js";
import type { AppBindings } from "../src/env.js";

// Drift check between the generated *.named-routes.gen.ts and a router's runtime
// route map.
//
// LIMITATION (see test/FINDINGS.md): the FULL app router file (src/router.tsx)
// cannot be imported in bare vitest — its page modules pull app-specific deps
// and/or plugin `virtual:` modules that need the Vite plugin. (Handler $$id is
// NOT the blocker: Prerender()/createLoader()/Static() each construct via a
// runtime fallback id.) So the whole-app drift check belongs in an e2e/build
// step. Here we exercise the primitive against the importable, focused API
// include — a real subtree — plus the real committed NamedRoutes file.
describe("assertGeneratedRoutesMatch (generated-route drift)", () => {
  const apiRouter = createRouter<AppBindings>({}).routes(apiPatterns);

  it("the API router's runtime map matches its expected generated patterns", async () => {
    // Built without the /api mount prefix, so names/paths are the handler-local
    // ones (health, products, productDetail, cacheInvalidate).
    await expect(
      assertGeneratedRoutesMatch(apiRouter, {
        cacheInvalidate: "/cache/invalidate",
        health: "/health",
        products: "/products",
        productDetail: "/products/:id",
      }),
    ).resolves.toBeUndefined();
  });

  it("reports a pattern mismatch when a generated path drifts", async () => {
    const diff = await diffGeneratedRoutes(apiRouter, {
      cacheInvalidate: "/cache/invalidate",
      health: "/health",
      products: "/products",
      productDetail: "/products/:slug", // drifted (:id -> :slug)
    });
    expect(diff.ok).toBe(false);
    expect(diff.mismatch).toContainEqual([
      "productDetail",
      "/products/:slug",
      "/products/:id",
    ]);
  });

  it("reports missing (generated, not at runtime) and extra (runtime, not generated)", async () => {
    const diff = await diffGeneratedRoutes(apiRouter, {
      health: "/health",
      // products + productDetail + cacheInvalidate omitted -> "extra" at runtime
      ghost: "/ghost", // present in generated only -> "missing"
    });
    expect(diff.missing).toContain("ghost");
    expect(diff.extra).toEqual(
      expect.arrayContaining(["products", "productDetail", "cacheInvalidate"]),
    );
  });

  it("the committed NamedRoutes file carries the mounted API route patterns", () => {
    // Sanity-pin the real generated file (mounted under /api in the full app).
    expect(NamedRoutes["api.health"]).toBe("/api/health");
    expect(NamedRoutes["api.products"]).toBe("/api/products");
    expect(NamedRoutes["api.productDetail"]).toBe("/api/products/:id");
    expect(NamedRoutes["api.cacheInvalidate"]).toBe("/api/cache/invalidate");
  });
});
