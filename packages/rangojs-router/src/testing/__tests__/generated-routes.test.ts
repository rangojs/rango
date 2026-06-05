import { describe, it, expect } from "vitest";
import {
  diffGeneratedRoutes,
  assertGeneratedRoutesMatch,
} from "../generated-routes.js";

// assertGeneratedRoutesMatch only reads router.routeMap, so a plain object
// satisfies the contract — no need to construct a full router (and pull in the
// RSC runtime) for this primitive.
function fakeRouter(routeMap: Record<string, unknown>): {
  routeMap: Record<string, unknown>;
} {
  return { routeMap };
}

describe("diffGeneratedRoutes", () => {
  it("reports ok when the maps are identical", () => {
    const router = fakeRouter({ home: "/", post: "/blog/:slug" });
    const generated = { home: "/", post: "/blog/:slug" };

    const diff = diffGeneratedRoutes(router, generated);

    expect(diff.ok).toBe(true);
    expect(diff.missing).toEqual([]);
    expect(diff.extra).toEqual([]);
    expect(diff.mismatch).toEqual([]);
  });

  it("detects a route in the generated map but missing at runtime", () => {
    const router = fakeRouter({ home: "/" });
    const generated = { home: "/", about: "/about" };

    const diff = diffGeneratedRoutes(router, generated);

    expect(diff.ok).toBe(false);
    expect(diff.missing).toEqual(["about"]);
    expect(diff.extra).toEqual([]);
  });

  it("detects a route at runtime but missing from the generated map", () => {
    const router = fakeRouter({ home: "/", contact: "/contact" });
    const generated = { home: "/" };

    const diff = diffGeneratedRoutes(router, generated);

    expect(diff.ok).toBe(false);
    expect(diff.extra).toEqual(["contact"]);
    expect(diff.missing).toEqual([]);
  });

  it("detects a pattern mismatch for the same name", () => {
    const router = fakeRouter({ post: "/blog/:slug" });
    const generated = { post: "/articles/:slug" };

    const diff = diffGeneratedRoutes(router, generated);

    expect(diff.ok).toBe(false);
    expect(diff.mismatch).toEqual([["post", "/articles/:slug", "/blog/:slug"]]);
  });

  it("compares on the .path for object-shaped route map entries", () => {
    const router = fakeRouter({ api: { path: "/api/data", response: "json" } });
    const generated = { api: "/api/data" };

    const diff = diffGeneratedRoutes(router, generated);

    expect(diff.ok).toBe(true);
  });
});

describe("assertGeneratedRoutesMatch", () => {
  it("does not throw on a match", () => {
    const router = fakeRouter({ home: "/", post: "/blog/:slug" });
    expect(() =>
      assertGeneratedRoutesMatch(router, { home: "/", post: "/blog/:slug" }),
    ).not.toThrow();
  });

  it("throws and lists missing, extra, and mismatched routes", () => {
    const router = fakeRouter({
      home: "/",
      contact: "/contact",
      post: "/blog/:slug",
    });
    const generated = {
      home: "/",
      about: "/about",
      post: "/articles/:slug",
    };

    let message = "";
    try {
      assertGeneratedRoutesMatch(router, generated);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("about"); // missing
    expect(message).toContain("contact"); // extra
    expect(message).toContain("post"); // mismatch
    expect(message).toContain("/articles/:slug");
    expect(message).toContain("/blog/:slug");
  });
});
