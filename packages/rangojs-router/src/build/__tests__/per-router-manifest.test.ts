import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateManifestFull } from "../generate-manifest";
import { buildRouteTrie, type TrieNode } from "../route-trie";
import { urls } from "../../urls";
import {
  setRouterManifest,
  getRouterManifest,
  setRouterTrie,
  getRouterTrie,
  setRouterPrecomputedEntries,
  getRouterPrecomputedEntries,
  registerRouterManifestLoader,
  ensureRouterManifest,
  setCachedManifest,
  clearCachedManifest,
  getGlobalRouteMap,
  setRouteTrie,
  getRouteTrie,
} from "../../route-map-builder";

/**
 * Collect the route names present in a built trie (keys only). Replaces the
 * old extractAncestryFromTrie, which returned name->ancestry; these tests only
 * ever asserted on the route-name key set (multi-router isolation).
 */
function trieRouteNames(node: TrieNode): Record<string, true> {
  const names: Record<string, true> = {};
  const visit = (n: TrieNode): void => {
    if (n.r) names[n.r.n] = true;
    if (n.w) names[n.w.n] = true;
    if (n.s) for (const child of Object.values(n.s)) visit(child);
    if (n.xp) for (const child of Object.values(n.xp)) visit(child.c);
    if (n.p) visit(n.p.c);
  };
  visit(node);
  return names;
}

// Simulate flattenLeafEntries from vite/index.ts (not exported, so replicate here)
function flattenLeafEntries(
  prefixTree: Record<string, any>,
  routeManifest: Record<string, string>,
  result: Array<{ staticPrefix: string; routes: Record<string, string> }>,
): void {
  function visit(node: any): void {
    const children = node.children || {};
    if (
      Object.keys(children).length === 0 &&
      node.routes &&
      node.routes.length > 0
    ) {
      const routes: Record<string, string> = {};
      for (const name of node.routes) {
        if (name in routeManifest) {
          routes[name] = routeManifest[name];
        }
      }
      result.push({ staticPrefix: node.staticPrefix, routes });
    } else {
      for (const child of Object.values(children)) {
        visit(child);
      }
    }
  }
  for (const node of Object.values(prefixTree)) {
    visit(node);
  }
}

function buildRouteToStaticPrefix(
  prefixTree: Record<string, any>,
  routeToStaticPrefix: Record<string, string>,
): void {
  function visit(node: any): void {
    if (node.routes) {
      for (const name of node.routes) {
        routeToStaticPrefix[name] = node.staticPrefix;
      }
    }
    if (node.children) {
      for (const child of Object.values(node.children) as any[]) {
        visit(child);
      }
    }
  }
  for (const node of Object.values(prefixTree)) {
    visit(node);
  }
}

// Two router urlpatterns that simulate the cloudflare-multi-router example:
// "site" has home + about, "admin" has dashboard + users
const sitePatterns = urls(({ path }) => [
  path("/", () => null, { name: "home" }),
  path("/about", () => null, { name: "about" }),
]);

const adminPatterns = urls(({ path }) => [
  path("/", () => null, { name: "dashboard" }),
  path("/users", () => null, { name: "users" }),
]);

describe("per-router manifest generation", () => {
  it("should generate disjoint route manifests for two routers", async () => {
    const siteManifest = await generateManifestFull(sitePatterns, 0);
    const adminManifest = await generateManifestFull(adminPatterns, 1);

    // Site manifest should only contain site routes
    expect(siteManifest.routeManifest).toEqual({
      home: "/",
      about: "/about",
    });

    // Admin manifest should only contain admin routes
    expect(adminManifest.routeManifest).toEqual({
      dashboard: "/",
      users: "/users",
    });

    // No overlap
    const siteKeys = Object.keys(siteManifest.routeManifest);
    const adminKeys = Object.keys(adminManifest.routeManifest);
    expect(siteKeys.filter((k) => adminKeys.includes(k))).toEqual([]);
  });

  it("should build per-router tries that only match own routes", async () => {
    const siteManifest = await generateManifestFull(sitePatterns, 0);
    const adminManifest = await generateManifestFull(adminPatterns, 1);

    // Build per-router static prefix maps
    const siteStaticPrefix: Record<string, string> = {};
    for (const name of Object.keys(siteManifest.routeManifest)) {
      siteStaticPrefix[name] = "";
    }
    buildRouteToStaticPrefix(siteManifest.prefixTree, siteStaticPrefix);

    const adminStaticPrefix: Record<string, string> = {};
    for (const name of Object.keys(adminManifest.routeManifest)) {
      adminStaticPrefix[name] = "";
    }
    buildRouteToStaticPrefix(adminManifest.prefixTree, adminStaticPrefix);

    // Build per-router tries
    const siteTrie = buildRouteTrie(
      siteManifest.routeManifest,
      siteStaticPrefix,
    );
    const adminTrie = buildRouteTrie(
      adminManifest.routeManifest,
      adminStaticPrefix,
    );

    // Extract route names from each trie
    const siteTrieRoutes = trieRouteNames(siteTrie);
    const adminTrieRoutes = trieRouteNames(adminTrie);

    // Site trie should only contain site routes
    expect(Object.keys(siteTrieRoutes)).toEqual(
      expect.arrayContaining(["home", "about"]),
    );
    expect(Object.keys(siteTrieRoutes)).not.toContain("dashboard");
    expect(Object.keys(siteTrieRoutes)).not.toContain("users");

    // Admin trie should only contain admin routes
    expect(Object.keys(adminTrieRoutes)).toEqual(
      expect.arrayContaining(["dashboard", "users"]),
    );
    expect(Object.keys(adminTrieRoutes)).not.toContain("home");
    expect(Object.keys(adminTrieRoutes)).not.toContain("about");
  });

  it("should produce isolated precomputed entries per router", async () => {
    const siteManifest = await generateManifestFull(sitePatterns, 0);
    const adminManifest = await generateManifestFull(adminPatterns, 1);

    const sitePrecomputed: Array<{
      staticPrefix: string;
      routes: Record<string, string>;
    }> = [];
    flattenLeafEntries(
      siteManifest.prefixTree,
      siteManifest.routeManifest,
      sitePrecomputed,
    );

    const adminPrecomputed: Array<{
      staticPrefix: string;
      routes: Record<string, string>;
    }> = [];
    flattenLeafEntries(
      adminManifest.prefixTree,
      adminManifest.routeManifest,
      adminPrecomputed,
    );

    // Each router's precomputed entries should only reference its own route names
    const siteRouteNames = sitePrecomputed.flatMap((e) =>
      Object.keys(e.routes),
    );
    const adminRouteNames = adminPrecomputed.flatMap((e) =>
      Object.keys(e.routes),
    );

    expect(siteRouteNames).not.toContain("dashboard");
    expect(siteRouteNames).not.toContain("users");

    expect(adminRouteNames).not.toContain("home");
    expect(adminRouteNames).not.toContain("about");
  });

  it("merged manifest should contain all routes from both routers", async () => {
    const siteManifest = await generateManifestFull(sitePatterns, 0);
    const adminManifest = await generateManifestFull(adminPatterns, 1);

    const merged: Record<string, string> = {};
    Object.assign(merged, siteManifest.routeManifest);
    Object.assign(merged, adminManifest.routeManifest);

    expect(merged).toEqual({
      home: "/",
      about: "/about",
      dashboard: "/",
      users: "/users",
    });
  });

  it("merged trie should contain routes from all routers", async () => {
    const siteManifest = await generateManifestFull(sitePatterns, 0);
    const adminManifest = await generateManifestFull(adminPatterns, 1);

    const mergedManifest: Record<string, string> = {};
    Object.assign(mergedManifest, siteManifest.routeManifest);
    Object.assign(mergedManifest, adminManifest.routeManifest);

    const mergedStaticPrefix: Record<string, string> = {};
    for (const name of Object.keys(mergedManifest)) {
      mergedStaticPrefix[name] = "";
    }

    const mergedTrie = buildRouteTrie(mergedManifest, mergedStaticPrefix);
    const trieRoutes = trieRouteNames(mergedTrie);

    // Merged trie has all routes (but "/" collides: last writer wins)
    expect(Object.keys(trieRoutes)).toContain("about");
    expect(Object.keys(trieRoutes)).toContain("users");
    // "/" maps to "dashboard" because admin was assigned second (Object.assign order)
    expect(trieRoutes).toHaveProperty("dashboard");
  });
});

describe("per-router manifest with includes", () => {
  const blogPatterns = urls(({ path }) => [
    path("/", () => null, { name: "list" }),
    path("/:slug", () => null, { name: "detail" }),
  ]);

  const siteWithIncludes = urls(({ path, include }) => [
    path("/", () => null, { name: "home" }),
    include("/blog", blogPatterns, { name: "blog" }),
  ]);

  const adminWithIncludes = urls(({ path, include }) => [
    path("/", () => null, { name: "dashboard" }),
    path("/settings", () => null, { name: "settings" }),
  ]);

  it("should produce per-router precomputed entries for routers with includes", async () => {
    const siteManifest = await generateManifestFull(siteWithIncludes, 0);
    const adminManifest = await generateManifestFull(adminWithIncludes, 1);

    // Site should have blog routes
    expect(siteManifest.routeManifest).toHaveProperty("blog.list", "/blog");
    expect(siteManifest.routeManifest).toHaveProperty(
      "blog.detail",
      "/blog/:slug",
    );
    expect(siteManifest.routeManifest).not.toHaveProperty("dashboard");

    // Admin should not have blog routes
    expect(adminManifest.routeManifest).not.toHaveProperty("blog.list");
    expect(adminManifest.routeManifest).toHaveProperty("dashboard", "/");

    // Per-router precomputed: site's blog include becomes a leaf
    const sitePrecomputed: Array<{
      staticPrefix: string;
      routes: Record<string, string>;
    }> = [];
    flattenLeafEntries(
      siteManifest.prefixTree,
      siteManifest.routeManifest,
      sitePrecomputed,
    );

    // The /blog include is a leaf node (no children), so it appears in precomputed
    const blogEntry = sitePrecomputed.find((e) => e.staticPrefix === "/blog");
    expect(blogEntry).toBeDefined();
    expect(blogEntry!.routes).toHaveProperty("blog.list");
    expect(blogEntry!.routes).toHaveProperty("blog.detail");
  });

  it("per-router tries should resolve dynamic params independently", async () => {
    const siteManifest = await generateManifestFull(siteWithIncludes, 0);
    const adminManifest = await generateManifestFull(adminWithIncludes, 1);

    const siteStaticPrefix: Record<string, string> = {};
    for (const name of Object.keys(siteManifest.routeManifest)) {
      siteStaticPrefix[name] = "";
    }
    buildRouteToStaticPrefix(siteManifest.prefixTree, siteStaticPrefix);

    const adminStaticPrefix: Record<string, string> = {};
    for (const name of Object.keys(adminManifest.routeManifest)) {
      adminStaticPrefix[name] = "";
    }
    buildRouteToStaticPrefix(adminManifest.prefixTree, adminStaticPrefix);

    const siteTrie = buildRouteTrie(
      siteManifest.routeManifest,
      siteStaticPrefix,
    );
    const adminTrie = buildRouteTrie(
      adminManifest.routeManifest,
      adminStaticPrefix,
    );

    const siteRoutes = trieRouteNames(siteTrie);
    const adminRoutes = trieRouteNames(adminTrie);

    // Site trie should have blog.detail (dynamic param route)
    expect(siteRoutes).toHaveProperty("blog.detail");
    expect(siteRoutes).not.toHaveProperty("settings");

    // Admin trie should have settings but no blog routes
    expect(adminRoutes).toHaveProperty("settings");
    expect(adminRoutes).not.toHaveProperty("blog.detail");
    expect(adminRoutes).not.toHaveProperty("blog.list");
  });
});

describe("per-router storage isolation", () => {
  beforeEach(() => {
    // Clear global state before each test
    clearCachedManifest();
    setRouteTrie(null);
  });

  it("should store and retrieve per-router manifests independently", async () => {
    setRouterManifest("site", { home: "/", about: "/about" });
    setRouterManifest("admin", { dashboard: "/", users: "/users" });

    expect(getRouterManifest("site")).toEqual({ home: "/", about: "/about" });
    expect(getRouterManifest("admin")).toEqual({
      dashboard: "/",
      users: "/users",
    });
    expect(getRouterManifest("unknown")).toBeUndefined();
  });

  it("should store and retrieve per-router tries independently", async () => {
    const siteTrie: TrieNode = { r: { n: "home", sp: "" } };
    const adminTrie: TrieNode = { r: { n: "dashboard", sp: "" } };

    setRouterTrie("site", siteTrie);
    setRouterTrie("admin", adminTrie);

    expect(getRouterTrie("site")).toBe(siteTrie);
    expect(getRouterTrie("admin")).toBe(adminTrie);
    expect(getRouterTrie("unknown")).toBeUndefined();
  });

  it("should store and retrieve per-router precomputed entries independently", async () => {
    const siteEntries = [
      { staticPrefix: "", routes: { home: "/", about: "/about" } },
    ];
    const adminEntries = [
      { staticPrefix: "", routes: { dashboard: "/", users: "/users" } },
    ];

    setRouterPrecomputedEntries("site", siteEntries);
    setRouterPrecomputedEntries("admin", adminEntries);

    expect(getRouterPrecomputedEntries("site")).toBe(siteEntries);
    expect(getRouterPrecomputedEntries("admin")).toBe(adminEntries);
    expect(getRouterPrecomputedEntries("unknown")).toBeUndefined();
  });

  it("should not affect global manifest when setting per-router data", async () => {
    setCachedManifest({ all: "/all" });
    setRouterManifest("site", { home: "/" });

    // Global manifest unchanged
    expect(getGlobalRouteMap()).toEqual({ all: "/all" });
    // Per-router data separate
    expect(getRouterManifest("site")).toEqual({ home: "/" });
  });
});

describe("ensureRouterManifest lazy loading", () => {
  it("should load manifest from registered loader on first call", async () => {
    const mockModule = {
      manifest: { home: "/", about: "/about" },
      trie: { r: { n: "home", sp: "", a: [] } } as TrieNode,
      precomputedEntries: [{ staticPrefix: "", routes: { home: "/" } }],
    };

    registerRouterManifestLoader("lazy-site", () =>
      Promise.resolve(mockModule),
    );

    // Before loading
    expect(getRouterManifest("lazy-site")).toBeUndefined();

    // Load
    await ensureRouterManifest("lazy-site");

    // After loading
    expect(getRouterManifest("lazy-site")).toEqual(mockModule.manifest);
    expect(getRouterTrie("lazy-site")).toBe(mockModule.trie);
    expect(getRouterPrecomputedEntries("lazy-site")).toBe(
      mockModule.precomputedEntries,
    );
  });

  it("should not re-load if manifest AND trie are already set", async () => {
    let loadCount = 0;
    registerRouterManifestLoader("cached", () => {
      loadCount++;
      return Promise.resolve({ manifest: { x: "/x" } });
    });

    // Pre-set both manifest and trie
    setRouterManifest("cached", { y: "/y" });
    setRouterTrie("cached", { type: "root", children: {} } as any);

    await ensureRouterManifest("cached");

    // Loader was never called because both manifest and trie already existed
    expect(loadCount).toBe(0);
    expect(getRouterManifest("cached")).toEqual({ y: "/y" });
  });

  it("should re-load if manifest is set but trie is missing", async () => {
    let loadCount = 0;
    const mockTrie = { type: "root", children: {} } as any;
    registerRouterManifestLoader("manifest-only", () => {
      loadCount++;
      return Promise.resolve({ manifest: { x: "/x" }, trie: mockTrie });
    });

    // Pre-set only the manifest (trie missing — e.g. virtual module in dev mode)
    setRouterManifest("manifest-only", { y: "/y" });

    await ensureRouterManifest("manifest-only");

    // Loader was called to load the missing trie
    expect(loadCount).toBe(1);
    expect(getRouterTrie("manifest-only")).toBe(mockTrie);
  });

  it("should remove loader after successful load", async () => {
    let loadCount = 0;
    registerRouterManifestLoader("once", () => {
      loadCount++;
      return Promise.resolve({ manifest: { z: "/z" } });
    });

    await ensureRouterManifest("once");
    expect(loadCount).toBe(1);

    // Second call: manifest exists, loader removed
    await ensureRouterManifest("once");
    expect(loadCount).toBe(1);
  });

  it("should handle loader with partial exports", async () => {
    // Only manifest, no trie or precomputedEntries
    registerRouterManifestLoader("partial", () =>
      Promise.resolve({ manifest: { a: "/a" } }),
    );

    await ensureRouterManifest("partial");

    expect(getRouterManifest("partial")).toEqual({ a: "/a" });
    expect(getRouterTrie("partial")).toBeUndefined();
    expect(getRouterPrecomputedEntries("partial")).toBeUndefined();
  });

  it("should be a no-op when no loader is registered", async () => {
    // No loader, no manifest
    await ensureRouterManifest("nonexistent");
    expect(getRouterManifest("nonexistent")).toBeUndefined();
  });
});
