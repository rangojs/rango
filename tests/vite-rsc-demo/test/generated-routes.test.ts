import { describe, expect, it } from "vitest";
import {
  assertGeneratedRoutesMatch,
  diffGeneratedRoutes,
} from "@rangojs/router/testing";
import { NamedRoutes } from "../src/router.named-routes.gen.js";

// The FULL vite-rsc-demo router file can't be imported in a bare test — its page
// modules pull app-specific deps and/or plugin `virtual:` modules that need the
// Vite plugin. (Handler $$id is NOT the blocker: Prerender()/createLoader()/
// Static() each construct via a runtime fallback id.) So this exercises the
// generated-routes primitive against the real committed NamedRoutes map plus a
// constructed runtime map — pinning the primitive's behavior and a few real route
// patterns. The whole-app drift check runs at build/e2e.
describe("generated-routes primitive against vite-rsc-demo's NamedRoutes", () => {
  it("the committed NamedRoutes carries the expected route patterns", () => {
    expect(NamedRoutes["shop.products.detail.view"]).toBe(
      "/shop/product/:slug",
    );
    expect(NamedRoutes["blog.post"]).toBe("/blog/:slug");
    expect(NamedRoutes["todos.detail"]).toBe("/todos/:id");
  });

  it("reports a clean diff when runtime == generated", async () => {
    const fakeRuntime = { routeMap: { ...NamedRoutes } };
    await expect(
      assertGeneratedRoutesMatch(fakeRuntime, NamedRoutes),
    ).resolves.toBeUndefined();
  });

  it("reports a pattern mismatch when a runtime pattern drifts", async () => {
    const fakeRuntime = {
      routeMap: { ...NamedRoutes, "blog.post": "/blog/posts/:slug" },
    };
    const diff = await diffGeneratedRoutes(fakeRuntime, NamedRoutes);
    expect(diff.ok).toBe(false);
    expect(diff.mismatch).toContainEqual([
      "blog.post",
      "/blog/:slug",
      "/blog/posts/:slug",
    ]);
  });
});
