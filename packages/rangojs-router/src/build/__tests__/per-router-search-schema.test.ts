import { describe, it, expect, beforeEach } from "vitest";
import { generateManifestFull } from "../generate-manifest";
import { urls } from "../../urls";
import {
  getSearchSchema,
  isRouteRootScoped,
  clearAllRouterData,
} from "../../route-map-builder";

// Two routers (multi-router / host-router shape) declare the SAME route name
// with DIFFERENT search schemas and root-scope. path() registers both into
// name-keyed registries at evaluation time; discovery evaluates every router
// at boot, so without per-router isolation the last-evaluated router wins for
// BOTH and a request served by the first router parses its search params with
// the other router's schema (handler-context.ts / loader-fetch.ts lookups).
// Fresh pattern objects per test: re-evaluating the SAME module-level urls()
// object skips include re-registration (real re-discovery re-imports modules,
// so production always evaluates fresh objects).
function sitePatterns() {
  const scoped = urls(({ path }) => [
    path("/shared", () => null, { name: "shared" }),
  ]);
  return urls(({ path, include }) => [
    path("/items", () => null, {
      name: "items",
      search: { q: "string" },
    }),
    // A named include boundary makes routes under it NON-root-scoped.
    include("/sub", scoped, { name: "scope" }),
  ]);
}

function adminPatterns() {
  return urls(({ path }) => [
    path("/items", () => null, {
      name: "items",
      search: { page: "number" },
    }),
    // Same bare name at ROOT scope in this router.
    path("/scope/shared", () => null, { name: "scope.shared" }),
  ]);
}

describe("per-router search schema and root-scope isolation", () => {
  beforeEach(() => {
    clearAllRouterData();
  });

  it("same-named routes keep their own search schema after both routers evaluated", async () => {
    await generateManifestFull(sitePatterns(), 0, { routerId: "site" });
    await generateManifestFull(adminPatterns(), 1, { routerId: "admin" });

    expect(getSearchSchema("items", "site")).toEqual({ q: "string" });
    expect(getSearchSchema("items", "admin")).toEqual({ page: "number" });
  });

  it("same-named routes keep their own root-scope after both routers evaluated", async () => {
    await generateManifestFull(sitePatterns(), 0, { routerId: "site" });
    await generateManifestFull(adminPatterns(), 1, { routerId: "admin" });

    expect(isRouteRootScoped("scope.shared", "site")).toBe(false);
    expect(isRouteRootScoped("scope.shared", "admin")).toBe(true);
  });

  it("falls back to the global registry when routerId is unknown or absent", async () => {
    await generateManifestFull(sitePatterns(), 0, { routerId: "site" });

    // No routerId (single-router apps, unit contexts): global fallback works.
    expect(getSearchSchema("items")).toEqual({ q: "string" });
    // Unknown routerId: fall back rather than dropping the schema.
    expect(getSearchSchema("items", "not-a-router")).toEqual({ q: "string" });
  });
});
