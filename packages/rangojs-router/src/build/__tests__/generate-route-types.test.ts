import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import {
  writeCombinedRouteTypes,
  generateRouteTypesSource,
  extractRoutesFromSource,
  extractParamsFromPattern,
  formatRouteEntry,
  generatePerModuleTypesSource,
  writePerModuleRouteTypesForFile,
  extractIncludesWithDiagnostics,
  detectUnresolvableIncludes,
  extractUrlsVariableFromRouter,
  extractUrlsFromRouter,
  extractBasenameFromRouter,
  findNestedRouterConflict,
  findRouterFiles,
  createScanFilter,
} from "../generate-route-types";

// Helper: create a minimal urls module that the static parser can extract routes from.
// The parser looks for path("pattern", ..., { name: "..." }) calls -- it does not
// execute code, so the handler reference can be anything.
function urlsSource(routes: Array<{ pattern: string; name: string }>): string {
  const pathCalls = routes
    .map((r) => `  path("${r.pattern}", handler, { name: "${r.name}" }),`)
    .join("\n");
  return `import { urls } from "@rangojs/router";
const handler = () => null;
export const patterns = urls(({ path }) => [
${pathCalls}
]);
`;
}

// Helper: create a minimal router module that imports patterns from a relative path.
function routerSource(urlsImportPath: string): string {
  return `import { createRouter } from "@rangojs/router";
import { patterns } from "${urlsImportPath}";
export const router = createRouter().routes(patterns);
`;
}

// Helper: gen file path for a router file
function genPath(routerFilePath: string): string {
  return routerFilePath.replace(/\.tsx?$/, ".named-routes.gen.ts");
}

describe("writeCombinedRouteTypes", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "route-types-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("treats a directory with a router file as a router root", () => {
    const appDir = join(tempDir, "src", "app");
    const nestedDir = join(appDir, "nested");
    const adminDir = join(tempDir, "src", "admin");

    mkdirSync(nestedDir, { recursive: true });
    mkdirSync(adminDir, { recursive: true });

    const appRouter = join(appDir, "router.ts");
    const nestedRouter = join(nestedDir, "router.ts");
    const adminRouter = join(adminDir, "router.ts");

    writeFileSync(appRouter, routerSource("./urls.js"));
    writeFileSync(nestedRouter, routerSource("./urls.js"));
    writeFileSync(adminRouter, routerSource("./urls.js"));

    const discovered = findRouterFiles(tempDir).sort();

    expect(discovered).toEqual([adminRouter, appRouter].sort());
    expect(discovered).not.toContain(nestedRouter);
  });

  // The rango() `discovery: { include, exclude }` option compiles to this
  // scanFilter via createScanFilter and is applied here in findRouterFiles
  // (the same path the Vite plugin populates state.scanFilter for).
  it("discovery.include restricts router discovery to matching files", () => {
    const routesDir = join(tempDir, "src", "routes");
    const legacyDir = join(tempDir, "src", "legacy");
    mkdirSync(routesDir, { recursive: true });
    mkdirSync(legacyDir, { recursive: true });
    const kept = join(routesDir, "router.ts");
    const dropped = join(legacyDir, "router.ts");
    writeFileSync(kept, routerSource("./urls.js"));
    writeFileSync(dropped, routerSource("./urls.js"));

    const filter = createScanFilter(tempDir, { include: ["src/routes/**"] });
    const discovered = findRouterFiles(tempDir, filter);

    expect(discovered).toContain(kept);
    expect(discovered).not.toContain(dropped);
  });

  it("discovery.exclude removes matching files from router discovery", () => {
    const appDir = join(tempDir, "src", "app");
    const draftDir = join(tempDir, "src", "draft");
    mkdirSync(appDir, { recursive: true });
    mkdirSync(draftDir, { recursive: true });
    const kept = join(appDir, "router.ts");
    const dropped = join(draftDir, "router.ts");
    writeFileSync(kept, routerSource("./urls.js"));
    writeFileSync(dropped, routerSource("./urls.js"));

    const filter = createScanFilter(tempDir, { exclude: ["src/draft/**"] });
    const discovered = findRouterFiles(tempDir, filter);

    expect(discovered).toContain(kept);
    expect(discovered).not.toContain(dropped);
  });

  it("ignores a createRouter( mention inside a comment or string literal", () => {
    const appDir = join(tempDir, "src", "app");
    const utilsDir = join(tempDir, "src", "utils");
    mkdirSync(appDir, { recursive: true });
    mkdirSync(utilsDir, { recursive: true });

    const realRouter = join(appDir, "router.ts");
    const decoy = join(utilsDir, "helpers.ts");

    writeFileSync(realRouter, routerSource("./urls.js"));
    // Mentions createRouter( only in a comment and a string — it must NOT be
    // detected as a router file (regression for a spurious "Multiple routers
    // found" error caused by scanning raw source).
    writeFileSync(
      decoy,
      `// The router entry calls createRouter() exactly once.\n` +
        `export const note = "see createRouter(opts) in the docs";\n` +
        `export function helper(): number {\n  return 42;\n}\n`,
    );

    const discovered = findRouterFiles(tempDir);

    expect(discovered).toContain(realRouter);
    expect(discovered).not.toContain(decoy);
  });

  it("detects explicit nested router conflicts", () => {
    const appRouter = join(tempDir, "src", "app", "router.ts");
    const nestedRouter = join(tempDir, "src", "app", "nested", "router.ts");
    const siblingRouter = join(tempDir, "src", "admin", "router.ts");

    const conflict = findNestedRouterConflict([
      appRouter,
      nestedRouter,
      siblingRouter,
    ]);

    expect(conflict).toEqual({
      ancestor: appRouter,
      nested: nestedRouter,
    });
  });

  it("detects nested router conflicts regardless of input order", () => {
    const appRouter = join(tempDir, "src", "app", "router.ts");
    const nestedRouter = join(tempDir, "src", "app", "nested", "router.ts");

    const conflict = findNestedRouterConflict([nestedRouter, appRouter]);

    expect(conflict).toEqual({
      ancestor: appRouter,
      nested: nestedRouter,
    });
  });

  it("does not report nested router conflicts for sibling roots", () => {
    const appRouter = join(tempDir, "src", "app", "router.ts");
    const adminRouter = join(tempDir, "src", "admin", "router.ts");

    expect(findNestedRouterConflict([appRouter, adminRouter])).toBeNull();
  });

  it("throws when asked to generate combined route types for nested routers", () => {
    const appDir = join(tempDir, "src", "app");
    const nestedDir = join(appDir, "nested");
    mkdirSync(nestedDir, { recursive: true });

    const appUrls = join(appDir, "urls.ts");
    const nestedUrls = join(nestedDir, "urls.ts");
    const appRouter = join(appDir, "router.ts");
    const nestedRouter = join(nestedDir, "router.ts");

    writeFileSync(appUrls, urlsSource([{ pattern: "/", name: "index" }]));
    writeFileSync(
      nestedUrls,
      urlsSource([{ pattern: "/detail", name: "detail" }]),
    );
    writeFileSync(appRouter, routerSource("./urls.js"));
    writeFileSync(nestedRouter, routerSource("./urls.js"));

    expect(() =>
      writeCombinedRouteTypes(tempDir, [appRouter, nestedRouter]),
    ).toThrow(/Nested router roots are not supported/);
  });

  it("should create .named-routes.gen.ts with correct routes", () => {
    const urlsPath = join(tempDir, "urls.ts");
    const routerPath = join(tempDir, "router.ts");
    writeFileSync(
      urlsPath,
      urlsSource([
        { pattern: "/", name: "index" },
        { pattern: "/about", name: "about" },
      ]),
    );
    writeFileSync(routerPath, routerSource("./urls.js"));

    writeCombinedRouteTypes(tempDir, [routerPath]);

    const outPath = genPath(routerPath);
    expect(existsSync(outPath)).toBe(true);

    const content = readFileSync(outPath, "utf-8");
    expect(content).toContain('about: "/about"');
    expect(content).toContain('index: "/"');
  });

  it("should not rewrite when content is unchanged", () => {
    const urlsPath = join(tempDir, "urls.ts");
    const routerPath = join(tempDir, "router.ts");
    writeFileSync(urlsPath, urlsSource([{ pattern: "/", name: "index" }]));
    writeFileSync(routerPath, routerSource("./urls.js"));

    writeCombinedRouteTypes(tempDir, [routerPath]);

    const outPath = genPath(routerPath);
    const stat1 = statSync(outPath);

    // Write again with same content
    writeCombinedRouteTypes(tempDir, [routerPath]);

    const stat2 = statSync(outPath);
    expect(stat2.mtimeMs).toBe(stat1.mtimeMs);
  });

  it("should block shrink when preserveIfLarger is set", () => {
    const urlsPath = join(tempDir, "urls.ts");
    const routerPath = join(tempDir, "router.ts");

    // Static parser will find 2 routes
    writeFileSync(
      urlsPath,
      urlsSource([
        { pattern: "/", name: "index" },
        { pattern: "/about", name: "about" },
      ]),
    );
    writeFileSync(routerPath, routerSource("./urls.js"));

    // Pre-seed the gen file with 3 routes (simulating runtime discovery)
    const outPath = genPath(routerPath);
    const largerContent = generateRouteTypesSource({
      index: "/",
      about: "/about",
      contact: "/contact",
    });
    writeFileSync(outPath, largerContent);

    writeCombinedRouteTypes(tempDir, [routerPath], { preserveIfLarger: true });

    // File should still contain the runtime-discovered 3 routes
    const after = readFileSync(outPath, "utf-8");
    expect(after).toContain("contact");
    expect(after).toBe(largerContent);
  });

  it("should ignore internal runtime-only routes when preserveIfLarger compares counts", () => {
    const urlsPath = join(tempDir, "urls.ts");
    const routerPath = join(tempDir, "router.ts");

    writeFileSync(
      urlsPath,
      urlsSource([
        { pattern: "/", name: "index" },
        { pattern: "/about", name: "about" },
      ]),
    );
    writeFileSync(routerPath, routerSource("./urls.js"));

    const outPath = genPath(routerPath);
    const dirtyRuntimeContent = generateRouteTypesSource({
      "$prefix_0.index": "/private",
      "$prefix_0.about": "/private/about",
      index: "/",
      about: "/about",
    });
    writeFileSync(outPath, dirtyRuntimeContent);

    writeCombinedRouteTypes(tempDir, [routerPath], { preserveIfLarger: true });

    const after = readFileSync(outPath, "utf-8");
    expect(after).not.toContain("$prefix_0.index");
    expect(after).toContain('index: "/"');
    expect(after).toContain('about: "/about"');
  });

  it("should never emit internal route names in generated named-routes", () => {
    const content = generateRouteTypesSource(
      {
        "$prefix_0.index": "/private",
        $path__health: "/health",
        index: "/",
      },
      {
        "$prefix_0.index": { q: "string" },
        $path__health: { probe: "boolean?" },
        index: { page: "number?" },
      },
    );

    expect(content).not.toContain("$prefix_0.index");
    expect(content).not.toContain("$path__health");
    expect(content).toContain(
      'index: { path: "/", search: { page: "number?" } }',
    );
  });

  it("should allow growth when preserveIfLarger is set", () => {
    const urlsPath = join(tempDir, "urls.ts");
    const routerPath = join(tempDir, "router.ts");

    // Static parser will find 3 routes
    writeFileSync(
      urlsPath,
      urlsSource([
        { pattern: "/", name: "index" },
        { pattern: "/about", name: "about" },
        { pattern: "/contact", name: "contact" },
      ]),
    );
    writeFileSync(routerPath, routerSource("./urls.js"));

    // Pre-seed with only 2 routes
    const outPath = genPath(routerPath);
    const smallerContent = generateRouteTypesSource({
      index: "/",
      about: "/about",
    });
    writeFileSync(outPath, smallerContent);

    writeCombinedRouteTypes(tempDir, [routerPath], { preserveIfLarger: true });

    const after = readFileSync(outPath, "utf-8");
    expect(after).toContain("contact");
    expect(after).not.toBe(smallerContent);
  });

  it("should allow equal count with different content when preserveIfLarger is set", () => {
    const urlsPath = join(tempDir, "urls.ts");
    const routerPath = join(tempDir, "router.ts");

    // Static parser will find 2 routes
    writeFileSync(
      urlsPath,
      urlsSource([
        { pattern: "/", name: "index" },
        { pattern: "/new-page", name: "newPage" },
      ]),
    );
    writeFileSync(routerPath, routerSource("./urls.js"));

    // Pre-seed with 2 different routes
    const outPath = genPath(routerPath);
    const existingContent = generateRouteTypesSource({
      index: "/",
      about: "/about",
    });
    writeFileSync(outPath, existingContent);

    writeCombinedRouteTypes(tempDir, [routerPath], { preserveIfLarger: true });

    const after = readFileSync(outPath, "utf-8");
    expect(after).toContain("newPage");
    expect(after).not.toContain("about");
  });

  it("should always write when preserveIfLarger is not set (HMR path)", () => {
    const urlsPath = join(tempDir, "urls.ts");
    const routerPath = join(tempDir, "router.ts");

    // Static parser will find 2 routes
    writeFileSync(
      urlsPath,
      urlsSource([
        { pattern: "/", name: "index" },
        { pattern: "/about", name: "about" },
      ]),
    );
    writeFileSync(routerPath, routerSource("./urls.js"));

    // Pre-seed with 3 routes
    const outPath = genPath(routerPath);
    const largerContent = generateRouteTypesSource({
      index: "/",
      about: "/about",
      contact: "/contact",
    });
    writeFileSync(outPath, largerContent);

    // Without preserveIfLarger, shrink is allowed
    writeCombinedRouteTypes(tempDir, [routerPath]);

    const after = readFileSync(outPath, "utf-8");
    expect(after).not.toContain("contact");
  });

  it("should still write routerB when routerA triggers preserveIfLarger guard", () => {
    // Set up two routers: A has a pre-seeded larger gen file, B has no gen file
    const urlsAPath = join(tempDir, "urlsA.ts");
    const routerAPath = join(tempDir, "routerA.ts");
    const urlsBPath = join(tempDir, "urlsB.ts");
    const routerBPath = join(tempDir, "routerB.ts");

    writeFileSync(urlsAPath, urlsSource([{ pattern: "/", name: "index" }]));
    writeFileSync(routerAPath, routerSource("./urlsA.js"));

    writeFileSync(
      urlsBPath,
      urlsSource([
        { pattern: "/dashboard", name: "dashboard" },
        { pattern: "/settings", name: "settings" },
      ]),
    );
    writeFileSync(routerBPath, routerSource("./urlsB.js"));

    // Pre-seed routerA's gen file with more routes than static parser finds
    const genAPath = genPath(routerAPath);
    writeFileSync(
      genAPath,
      generateRouteTypesSource({
        index: "/",
        about: "/about",
        contact: "/contact",
      }),
    );

    // routerB has no gen file yet
    const genBPath = genPath(routerBPath);
    expect(existsSync(genBPath)).toBe(false);

    writeCombinedRouteTypes(tempDir, [routerAPath, routerBPath], {
      preserveIfLarger: true,
    });

    // routerA should be preserved (guard triggered)
    const afterA = readFileSync(genAPath, "utf-8");
    expect(afterA).toContain("contact");

    // routerB should have been written despite routerA triggering the guard
    expect(existsSync(genBPath)).toBe(true);
    const afterB = readFileSync(genBPath, "utf-8");
    expect(afterB).toContain("dashboard");
    expect(afterB).toContain("settings");
  });
});

// ---------------------------------------------------------------------------
// extractParamsFromPattern
// ---------------------------------------------------------------------------

describe("extractParamsFromPattern", () => {
  it("returns undefined for patterns without params", () => {
    expect(extractParamsFromPattern("/")).toBeUndefined();
    expect(extractParamsFromPattern("/about")).toBeUndefined();
    expect(extractParamsFromPattern("/api/search")).toBeUndefined();
  });

  it("extracts required params", () => {
    expect(extractParamsFromPattern("/:slug")).toEqual({ slug: "string" });
    expect(extractParamsFromPattern("/:id/items")).toEqual({ id: "string" });
  });

  it("extracts optional params", () => {
    expect(extractParamsFromPattern("/:id?")).toEqual({ id: "string?" });
  });

  it("extracts multiple params", () => {
    expect(extractParamsFromPattern("/:category/:slug")).toEqual({
      category: "string",
      slug: "string",
    });
  });

  it("handles params with regex constraints", () => {
    expect(extractParamsFromPattern("/:id(\\d+)")).toEqual({ id: "string" });
  });

  it("handles mixed required and optional params", () => {
    expect(extractParamsFromPattern("/:id/comments/:commentId?")).toEqual({
      id: "string",
      commentId: "string?",
    });
  });
});

// ---------------------------------------------------------------------------
// extractRoutesFromSource (AST)
// ---------------------------------------------------------------------------

describe("extractRoutesFromSource", () => {
  it("extracts named path() calls", () => {
    const code = `
      const handler = () => null;
      path("/", handler, { name: "index" });
      path("/about", handler, { name: "about" });
    `;
    const routes = extractRoutesFromSource(code);
    expect(routes).toEqual([
      { name: "index", pattern: "/" },
      { name: "about", pattern: "/about" },
    ]);
  });

  it("skips unnamed path() calls", () => {
    const code = `
      path("/", handler);
      path("/about", handler, { name: "about" });
    `;
    const routes = extractRoutesFromSource(code);
    expect(routes).toHaveLength(1);
    expect(routes[0].name).toBe("about");
  });

  it("handles path.json() and path.md() helpers", () => {
    const code = `
      path.json("/api/data", handler, { name: "api" });
      path.md("/docs/readme", handler, { name: "readme" });
    `;
    const routes = extractRoutesFromSource(code);
    expect(routes).toEqual([
      { name: "api", pattern: "/api/data" },
      { name: "readme", pattern: "/docs/readme" },
    ]);
  });

  it("extracts search schemas", () => {
    const code = `
      path("/search", handler, {
        name: "search",
        search: { q: "string", page: "number?" },
      });
    `;
    const routes = extractRoutesFromSource(code);
    expect(routes).toEqual([
      {
        name: "search",
        pattern: "/search",
        search: { q: "string", page: "number?" },
      },
    ]);
  });

  it("extracts params from pattern", () => {
    const code = `
      path("/:slug", handler, { name: "detail" });
    `;
    const routes = extractRoutesFromSource(code);
    expect(routes).toEqual([
      { name: "detail", pattern: "/:slug", params: { slug: "string" } },
    ]);
  });

  it("extracts params and search together", () => {
    const code = `
      path("/:id/items", handler, {
        name: "items",
        search: { page: "number?" },
      });
    `;
    const routes = extractRoutesFromSource(code);
    expect(routes).toEqual([
      {
        name: "items",
        pattern: "/:id/items",
        params: { id: "string" },
        search: { page: "number?" },
      },
    ]);
  });

  it("handles JSX handlers and multi-line expressions", () => {
    const code = `
      path(
        "/:slug",
        (ctx) => (
          <Article
            article={articles.find((a) => a.slug === ctx.params.slug) ?? null}
            slug={ctx.params.slug}
          />
        ),
        { name: "detail" },
      )
    `;
    const routes = extractRoutesFromSource(code);
    expect(routes).toHaveLength(1);
    expect(routes[0].name).toBe("detail");
    expect(routes[0].pattern).toBe("/:slug");
  });

  it("handles paths inside urls() callback", () => {
    const code = `
      import { urls } from "@rangojs/router";
      export const patterns = urls(({ path }) => [
        path("/", handler, { name: "index" }),
        path("/:slug", handler, { name: "detail" }),
      ]);
    `;
    const routes = extractRoutesFromSource(code);
    expect(routes).toHaveLength(2);
    expect(routes[0]).toEqual({ name: "index", pattern: "/" });
    expect(routes[1]).toEqual({
      name: "detail",
      pattern: "/:slug",
      params: { slug: "string" },
    });
  });
});

// ---------------------------------------------------------------------------
// formatRouteEntry
// ---------------------------------------------------------------------------

describe("formatRouteEntry", () => {
  it("formats plain routes as strings", () => {
    expect(formatRouteEntry("index", "/")).toBe('  index: "/",');
    expect(formatRouteEntry("about", "/about")).toBe('  about: "/about",');
  });

  it("formats routes with params as plain strings (params extracted at type level)", () => {
    expect(formatRouteEntry("detail", "/:slug", { slug: "string" })).toBe(
      '  detail: "/:slug",',
    );
  });

  it("formats routes with search as objects", () => {
    expect(
      formatRouteEntry("search", "/search", undefined, { q: "string" }),
    ).toBe('  search: { path: "/search", search: { q: "string" } },');
  });

  it("formats routes with params and search as objects with search only", () => {
    expect(
      formatRouteEntry(
        "items",
        "/:id/items",
        { id: "string" },
        { page: "number?" },
      ),
    ).toBe('  items: { path: "/:id/items", search: { page: "number?" } },');
  });
});

// ---------------------------------------------------------------------------
// Consistency: per-module vs named-routes output
// ---------------------------------------------------------------------------

describe("per-module vs named-routes consistency", () => {
  it("produces same route entries for static patterns", () => {
    const source = `
      path("/", handler, { name: "index" });
      path("/about", handler, { name: "about" });
    `;
    const routes = extractRoutesFromSource(source);
    const perModule = generatePerModuleTypesSource(routes);

    const manifest: Record<string, string> = {};
    for (const r of routes) manifest[r.name] = r.pattern;
    const namedRoutes = generateRouteTypesSource(manifest);

    // Both should contain the same route entries (different wrapper structure)
    expect(perModule).toContain('about: "/about"');
    expect(namedRoutes).toContain('about: "/about"');
    expect(perModule).toContain('index: "/"');
    expect(namedRoutes).toContain('index: "/"');
  });

  it("produces same route entries for parameterized patterns", () => {
    const source = `
      path("/:slug", handler, { name: "detail" });
      path("/:id/items", handler, {
        name: "items",
        search: { page: "number?" },
      });
    `;
    const routes = extractRoutesFromSource(source);
    const perModule = generatePerModuleTypesSource(routes);

    const manifest: Record<string, string> = {};
    const searchSchemas: Record<string, Record<string, string>> = {};
    for (const r of routes) {
      manifest[r.name] = r.pattern;
      if (r.search) searchSchemas[r.name] = r.search;
    }
    const namedRoutes = generateRouteTypesSource(manifest, searchSchemas);

    // Parameterized routes without search stay as plain strings
    expect(perModule).toContain('detail: "/:slug"');
    expect(namedRoutes).toContain('detail: "/:slug"');

    // Routes with search use object format (params excluded, extracted at type level)
    const itemsEntry =
      'items: { path: "/:id/items", search: { page: "number?" } }';
    expect(perModule).toContain(itemsEntry);
    expect(namedRoutes).toContain(itemsEntry);
  });
});

// ---------------------------------------------------------------------------
// writePerModuleRouteTypesForFile with recursive includes
// ---------------------------------------------------------------------------

describe("writePerModuleRouteTypesForFile with includes", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "per-module-includes-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("follows include() to a sub-module and merges routes", () => {
    // Sub-module with API routes
    const apiPath = join(tempDir, "api-urls.ts");
    writeFileSync(
      apiPath,
      `import { urls } from "@rangojs/router";
const handler = () => null;
export const apiUrls = urls(({ path }) => [
  path("/users", handler, { name: "users" }),
  path("/posts", handler, { name: "posts" }),
]);
`,
    );

    // Main module that includes the sub-module
    const mainPath = join(tempDir, "urls.ts");
    writeFileSync(
      mainPath,
      `import { urls } from "@rangojs/router";
import { apiUrls } from "./api-urls.js";
const handler = () => null;
export const patterns = urls(({ path, include }) => [
  path("/", handler, { name: "index" }),
  include("/api", apiUrls, { name: "api" }),
]);
`,
    );

    writePerModuleRouteTypesForFile(mainPath);

    const genPath = mainPath.replace(/\.ts$/, ".gen.ts");
    expect(existsSync(genPath)).toBe(true);

    const content = readFileSync(genPath, "utf-8");
    // Local route
    expect(content).toContain('index: "/"');
    // Included routes with prefixes
    expect(content).toContain("api.users");
    expect(content).toContain("/api/users");
    expect(content).toContain("api.posts");
    expect(content).toContain("/api/posts");
  });

  it("does not export child route names from include() without a name", () => {
    const adminPath = join(tempDir, "admin-urls.ts");
    writeFileSync(
      adminPath,
      `import { urls } from "@rangojs/router";
const handler = () => null;
export const adminUrls = urls(({ path }) => [
  path("/", handler, { name: "index" }),
  path("/users", handler, { name: "users" }),
]);
`,
    );

    const mainPath = join(tempDir, "urls.ts");
    writeFileSync(
      mainPath,
      `import { urls } from "@rangojs/router";
import { adminUrls } from "./admin-urls.js";
const handler = () => null;
export const patterns = urls(({ path, include }) => [
  path("/", handler, { name: "home" }),
  include("/admin", adminUrls),
]);
`,
    );

    writePerModuleRouteTypesForFile(mainPath);

    const genPath = mainPath.replace(/\.ts$/, ".gen.ts");
    const content = readFileSync(genPath, "utf-8");
    expect(content).toContain('home: "/"');
    expect(content).not.toContain('index: "/admin"');
    expect(content).not.toContain('users: "/admin/users"');
    expect(content).not.toContain("/admin/users");
  });

  it('exports flattened child names when include() uses { name: "" }', () => {
    const adminPath = join(tempDir, "admin-urls.ts");
    writeFileSync(
      adminPath,
      `import { urls } from "@rangojs/router";
const handler = () => null;
export const adminUrls = urls(({ path }) => [
  path("/", handler, { name: "dashboard" }),
  path("/users", handler, { name: "users" }),
]);
`,
    );

    const mainPath = join(tempDir, "urls.ts");
    writeFileSync(
      mainPath,
      `import { urls } from "@rangojs/router";
import { adminUrls } from "./admin-urls.js";
const handler = () => null;
export const patterns = urls(({ path, include }) => [
  path("/", handler, { name: "home" }),
  include("/admin", adminUrls, { name: "" }),
]);
`,
    );

    writePerModuleRouteTypesForFile(mainPath);

    const genPath = mainPath.replace(/\.ts$/, ".gen.ts");
    const content = readFileSync(genPath, "utf-8");
    expect(content).toContain('home: "/"');
    // Flattened — no prefix
    expect(content).toContain('dashboard: "/admin"');
    expect(content).toContain('users: "/admin/users"');
    // Not under any scope prefix
    expect(content).not.toContain("$prefix_");
  });

  it('exports prefixed child names when include() uses { name: "foo" }', () => {
    const childPath = join(tempDir, "child-urls.ts");
    writeFileSync(
      childPath,
      `import { urls } from "@rangojs/router";
const handler = () => null;
export const childUrls = urls(({ path }) => [
  path("/", handler, { name: "child" }),
  path("/detail", handler, { name: "detail" }),
]);
`,
    );

    const mainPath = join(tempDir, "urls.ts");
    writeFileSync(
      mainPath,
      `import { urls } from "@rangojs/router";
import { childUrls } from "./child-urls.js";
const handler = () => null;
export const patterns = urls(({ path, include }) => [
  path("/", handler, { name: "home" }),
  include("/x", childUrls, { name: "foo" }),
]);
`,
    );

    writePerModuleRouteTypesForFile(mainPath);

    const genPath = mainPath.replace(/\.ts$/, ".gen.ts");
    const content = readFileSync(genPath, "utf-8");
    expect(content).toContain('home: "/"');
    // Prefixed with foo.
    expect(content).toContain('"foo.child": "/x"');
    expect(content).toContain('"foo.detail": "/x/detail"');
    // Not flat or hidden
    expect(content).not.toContain('child: "/x"');
    expect(content).not.toContain("$prefix_");
  });

  it("follows multi-level includes (A -> B -> C)", () => {
    // Level C: leaf routes
    const cPath = join(tempDir, "c-urls.ts");
    writeFileSync(
      cPath,
      `import { urls } from "@rangojs/router";
const handler = () => null;
export const cUrls = urls(({ path }) => [
  path("/leaf", handler, { name: "leaf" }),
]);
`,
    );

    // Level B: includes C
    const bPath = join(tempDir, "b-urls.ts");
    writeFileSync(
      bPath,
      `import { urls } from "@rangojs/router";
import { cUrls } from "./c-urls.js";
const handler = () => null;
export const bUrls = urls(({ path, include }) => [
  path("/mid", handler, { name: "mid" }),
  include("/nested", cUrls, { name: "nested" }),
]);
`,
    );

    // Level A: includes B
    const aPath = join(tempDir, "urls.ts");
    writeFileSync(
      aPath,
      `import { urls } from "@rangojs/router";
import { bUrls } from "./b-urls.js";
const handler = () => null;
export const patterns = urls(({ path, include }) => [
  path("/", handler, { name: "index" }),
  include("/b", bUrls, { name: "b" }),
]);
`,
    );

    writePerModuleRouteTypesForFile(aPath);

    const genPath = aPath.replace(/\.ts$/, ".gen.ts");
    const content = readFileSync(genPath, "utf-8");

    // Local route
    expect(content).toContain('index: "/"');
    // Level B route with prefix
    expect(content).toContain("b.mid");
    expect(content).toContain("/b/mid");
    // Level C route with chained prefixes
    expect(content).toContain("b.nested.leaf");
    expect(content).toContain("/b/nested/leaf");
  });

  it("handles circular includes without infinite loop and warns", () => {
    // Module A includes B, module B includes A
    const aPath = join(tempDir, "a-urls.ts");
    const bPath = join(tempDir, "b-urls.ts");

    writeFileSync(
      aPath,
      `import { urls } from "@rangojs/router";
import { bUrls } from "./b-urls.js";
const handler = () => null;
export const aUrls = urls(({ path, include }) => [
  path("/a-route", handler, { name: "aRoute" }),
  include("/b", bUrls, { name: "b" }),
]);
`,
    );

    writeFileSync(
      bPath,
      `import { urls } from "@rangojs/router";
import { aUrls } from "./a-urls.js";
const handler = () => null;
export const bUrls = urls(({ path, include }) => [
  path("/b-route", handler, { name: "bRoute" }),
  include("/a", aUrls, { name: "a" }),
]);
`,
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Should not hang or throw — the visited set breaks the cycle
    writePerModuleRouteTypesForFile(aPath);

    const genPath = aPath.replace(/\.ts$/, ".gen.ts");
    const content = readFileSync(genPath, "utf-8");

    // A's own route
    expect(content).toContain("aRoute");
    // B's route included from A
    expect(content).toContain("b.bRoute");

    // Should warn about the circular reference
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Circular include detected"),
    );

    warnSpy.mockRestore();
  });

  it("includes params from sub-module parameterized routes", () => {
    const subPath = join(tempDir, "detail-urls.ts");
    writeFileSync(
      subPath,
      `import { urls } from "@rangojs/router";
const handler = () => null;
export const detailUrls = urls(({ path }) => [
  path("/:slug", handler, { name: "detail" }),
]);
`,
    );

    const mainPath = join(tempDir, "urls.ts");
    writeFileSync(
      mainPath,
      `import { urls } from "@rangojs/router";
import { detailUrls } from "./detail-urls.js";
const handler = () => null;
export const patterns = urls(({ path, include }) => [
  path("/", handler, { name: "index" }),
  include("/docs", detailUrls, { name: "docs" }),
]);
`,
    );

    writePerModuleRouteTypesForFile(mainPath);

    const genPath = mainPath.replace(/\.ts$/, ".gen.ts");
    const content = readFileSync(genPath, "utf-8");

    // The included route should have the combined prefix + pattern with param
    expect(content).toContain('"docs.detail": "/docs/:slug",');
  });

  it("falls back to direct extraction when no urls() variable exists", () => {
    // File with path() calls but no urls() variable assignment
    const filePath = join(tempDir, "urls.ts");
    writeFileSync(
      filePath,
      `import { urls } from "@rangojs/router";
const handler = () => null;
export default urls(({ path }) => [
  path("/", handler, { name: "index" }),
]);
`,
    );

    writePerModuleRouteTypesForFile(filePath);

    const genPath = filePath.replace(/\.ts$/, ".gen.ts");
    expect(existsSync(genPath)).toBe(true);
    const content = readFileSync(genPath, "utf-8");
    expect(content).toContain('index: "/"');
  });

  it("handles same-file includes (no import needed)", () => {
    const filePath = join(tempDir, "urls.ts");
    writeFileSync(
      filePath,
      `import { urls } from "@rangojs/router";
const handler = () => null;
const apiUrls = urls(({ path }) => [
  path("/users", handler, { name: "users" }),
]);
export const patterns = urls(({ path, include }) => [
  path("/", handler, { name: "index" }),
  include("/api", apiUrls, { name: "api" }),
]);
`,
    );

    writePerModuleRouteTypesForFile(filePath);

    const genPath = filePath.replace(/\.ts$/, ".gen.ts");
    const content = readFileSync(genPath, "utf-8");

    expect(content).toContain('index: "/"');
    expect(content).toContain("api.users");
    expect(content).toContain("/api/users");
  });

  it("emits empty placeholder when urls() variable exists but routes are unresolvable", () => {
    // Dynamic/factory-generated routes that the static parser cannot resolve
    const filePath = join(tempDir, "urls.ts");
    writeFileSync(
      filePath,
      `import { urls } from "@rangojs/router";
import { buildRoutes } from "./factory.js";
export const patterns = urls(buildRoutes);
`,
    );

    writePerModuleRouteTypesForFile(filePath);

    const genPath = filePath.replace(/\.ts$/, ".gen.ts");
    expect(existsSync(genPath)).toBe(true);

    const content = readFileSync(genPath, "utf-8");
    expect(content).toContain("export const routes = {");
    expect(content).toContain("} as const;");
  });

  it("does not overwrite existing gen file when urls() variable resolves zero routes", () => {
    const filePath = join(tempDir, "urls.ts");
    writeFileSync(
      filePath,
      `import { urls } from "@rangojs/router";
import { buildRoutes } from "./factory.js";
export const patterns = urls(buildRoutes);
`,
    );

    // Pre-seed a gen file (simulating runtime discovery)
    const genPath = filePath.replace(/\.ts$/, ".gen.ts");
    const existingContent = generatePerModuleTypesSource([
      { name: "index", pattern: "/" },
    ]);
    writeFileSync(genPath, existingContent);

    writePerModuleRouteTypesForFile(filePath);

    // Should not overwrite the richer runtime-discovered content
    const after = readFileSync(genPath, "utf-8");
    expect(after).toBe(existingContent);
  });

  it("includes the same imported variable under multiple prefixes without false cycle detection", () => {
    const sharedPath = join(tempDir, "shared-urls.ts");
    writeFileSync(
      sharedPath,
      `import { urls } from "@rangojs/router";
const handler = () => null;
export const sharedUrls = urls(({ path }) => [
  path("/health", handler, { name: "health" }),
  path("/:id", handler, { name: "detail" }),
]);
`,
    );

    const mainPath = join(tempDir, "urls.ts");
    writeFileSync(
      mainPath,
      `import { urls } from "@rangojs/router";
import { sharedUrls } from "./shared-urls.js";
const handler = () => null;
export const patterns = urls(({ path, include }) => [
  path("/", handler, { name: "home" }),
  include("/api", sharedUrls, { name: "api" }),
  include("/v2", sharedUrls, { name: "v2" }),
]);
`,
    );

    writePerModuleRouteTypesForFile(mainPath);

    const genPath = mainPath.replace(/\.ts$/, ".gen.ts");
    const content = readFileSync(genPath, "utf-8");

    // Both mounts should be present
    expect(content).toContain('"api.health"');
    expect(content).toContain('"/api/health"');
    expect(content).toContain('"api.detail"');
    expect(content).toContain('"/api/:id"');
    expect(content).toContain('"v2.health"');
    expect(content).toContain('"/v2/health"');
    expect(content).toContain('"v2.detail"');
    expect(content).toContain('"/v2/:id"');
  });

  it("still skips gen file when no urls() variable and no routes found", () => {
    // File contains urls( in a comment but no actual urls() variable
    const filePath = join(tempDir, "urls.ts");
    writeFileSync(
      filePath,
      `// This file uses urls( pattern but has no named routes
const x = 42;
`,
    );

    writePerModuleRouteTypesForFile(filePath);

    const genPath = filePath.replace(/\.ts$/, ".gen.ts");
    expect(existsSync(genPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractIncludesWithDiagnostics
// ---------------------------------------------------------------------------

describe("extractIncludesWithDiagnostics", () => {
  it("separates resolved identifiers from factory calls", () => {
    const code = `
import { urls } from "@rangojs/router";
import { apiUrls } from "./api/urls.js";
import { createDocsPatterns } from "./factory.js";
export const urlpatterns = urls(({ path, include }) => [
  path("/", handler, { name: "home" }),
  include("/api", apiUrls, { name: "api" }),
  include("/docs", createDocsPatterns(), { name: "docs" }),
]);
`;
    const { resolved, unresolvable } = extractIncludesWithDiagnostics(code);

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toEqual({
      pathPrefix: "/api",
      variableName: "apiUrls",
      namePrefix: "api",
    });

    expect(unresolvable).toHaveLength(1);
    expect(unresolvable[0].pathPrefix).toBe("/docs");
    expect(unresolvable[0].namePrefix).toBe("docs");
    expect(unresolvable[0].reason).toBe("factory-call");
    expect(unresolvable[0].detail).toContain("createDocsPatterns");
  });

  it("returns all resolved when no factory calls", () => {
    const code = `
import { urls } from "@rangojs/router";
import { fooUrls } from "./foo.js";
import { barUrls } from "./bar.js";
export const patterns = urls(({ include }) => [
  include("/foo", fooUrls, { name: "foo" }),
  include("/bar", barUrls, { name: "bar" }),
]);
`;
    const { resolved, unresolvable } = extractIncludesWithDiagnostics(code);
    expect(resolved).toHaveLength(2);
    expect(unresolvable).toHaveLength(0);
  });

  it("handles multiple factory calls", () => {
    const code = `
export const patterns = urls(({ include }) => [
  include("/a", createA()),
  include("/b", createB(), { name: "b" }),
]);
`;
    const { resolved, unresolvable } = extractIncludesWithDiagnostics(code);
    expect(resolved).toHaveLength(0);
    expect(unresolvable).toHaveLength(2);
    expect(unresolvable[0].reason).toBe("factory-call");
    expect(unresolvable[1].reason).toBe("factory-call");
  });
});

// ---------------------------------------------------------------------------
// detectUnresolvableIncludes
// ---------------------------------------------------------------------------

describe("detectUnresolvableIncludes", () => {
  const factoryFixtureDir = join(__dirname, "__fixtures__", "app-with-factory");

  it("returns factory-call diagnostic for factory fixture", () => {
    const routerFile = join(factoryFixtureDir, "router.tsx");
    const diagnostics = detectUnresolvableIncludes(routerFile);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].reason).toBe("factory-call");
    expect(diagnostics[0].pathPrefix).toBe("/docs");
    expect(diagnostics[0].namePrefix).toBe("docs");
    expect(diagnostics[0].detail).toContain("createDocsPatterns");
  });

  it("returns empty for fully static fixture", () => {
    const staticFixtureDir = join(__dirname, "__fixtures__", "app");
    const routerFile = join(staticFixtureDir, "router.tsx");
    const diagnostics = detectUnresolvableIncludes(routerFile);

    expect(diagnostics).toHaveLength(0);
  });

  it("returns file-not-found for missing import target", () => {
    const dir = mkdtempSync(join(tmpdir(), "rango-test-"));
    writeFileSync(
      join(dir, "router.tsx"),
      `import { createRouter } from "@rangojs/router";
import { urlpatterns } from "./urls.js";
export const router = createRouter().routes(urlpatterns);
`,
    );
    writeFileSync(
      join(dir, "urls.tsx"),
      `import { urls } from "@rangojs/router";
import { missingUrls } from "./nonexistent.js";
const handler = () => null;
export const urlpatterns = urls(({ path, include }) => [
  path("/", handler, { name: "home" }),
  include("/missing", missingUrls, { name: "missing" }),
]);
`,
    );

    const diagnostics = detectUnresolvableIncludes(join(dir, "router.tsx"));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].reason).toBe("file-not-found");
    expect(diagnostics[0].namePrefix).toBe("missing");

    rmSync(dir, { recursive: true, force: true });
  });

  it("returns unresolvable-import for variable not in imports or same-file scope", () => {
    const dir = mkdtempSync(join(tmpdir(), "rango-test-"));
    writeFileSync(
      join(dir, "router.tsx"),
      `import { createRouter } from "@rangojs/router";
import { urlpatterns } from "./urls.js";
export const router = createRouter().routes(urlpatterns);
`,
    );
    writeFileSync(
      join(dir, "urls.tsx"),
      `import { urls } from "@rangojs/router";
const handler = () => null;
export const urlpatterns = urls(({ path, include }) => [
  path("/", handler, { name: "home" }),
  include("/ghost", ghostUrls, { name: "ghost" }),
]);
`,
    );

    const diagnostics = detectUnresolvableIncludes(join(dir, "router.tsx"));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].reason).toBe("unresolvable-import");
    expect(diagnostics[0].namePrefix).toBe("ghost");
    expect(diagnostics[0].detail).toContain("ghostUrls");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// extractUrlsVariableFromRouter (AST-based)
// ---------------------------------------------------------------------------

describe("extractUrlsVariableFromRouter", () => {
  it("extracts from .routes(varName) chain", () => {
    const code = `
import { createRouter } from "@rangojs/router";
import { urlpatterns } from "./urls.js";
export const router = createRouter().routes(urlpatterns);
`;
    expect(extractUrlsVariableFromRouter(code)).toBe("urlpatterns");
  });

  it("extracts from createRouter<T>().routes(varName) with generic", () => {
    const code = `
import { createRouter } from "@rangojs/router";
import { urlpatterns } from "./urls.js";
export const router = createRouter<AppEnv>({
  document: Document,
}).routes(urlpatterns);
`;
    expect(extractUrlsVariableFromRouter(code)).toBe("urlpatterns");
  });

  it("extracts from chained .middleware().routes(varName)", () => {
    const code = `
import { createRouter } from "@rangojs/router";
import { sitePatterns } from "./urls.js";
export const router = createRouter<AppEnv>({
  document: Document,
}).middleware([authMiddleware]).routes(sitePatterns);
`;
    expect(extractUrlsVariableFromRouter(code)).toBe("sitePatterns");
  });

  it("extracts from createRouter({ urls: varName })", () => {
    const code = `
import { createRouter } from "@rangojs/router";
import { urlpatterns } from "./urls.js";
export const router = createRouter({ urls: urlpatterns, document: Document });
`;
    expect(extractUrlsVariableFromRouter(code)).toBe("urlpatterns");
  });

  it("returns null when no createRouter call exists", () => {
    const code = `
import { urls } from "@rangojs/router";
const handler = () => null;
export const patterns = urls(({ path }) => [
  path("/", handler, { name: "home" }),
]);
`;
    expect(extractUrlsVariableFromRouter(code)).toBeNull();
  });

  it("does not match .routes() on non-createRouter calls", () => {
    const code = `
const config = someBuilder().routes(myRoutes);
`;
    expect(extractUrlsVariableFromRouter(code)).toBeNull();
  });

  it("does not match urls: in non-createRouter objects", () => {
    const code = `
const config = { urls: myHelper, other: true };
`;
    expect(extractUrlsVariableFromRouter(code)).toBeNull();
  });

  it("handles createRouter with options and .routes() chained", () => {
    const code = `
export const router = createRouter({
  document: Document,
  theme: { defaultTheme: "light" },
}).routes(urlpatterns);
`;
    expect(extractUrlsVariableFromRouter(code)).toBe("urlpatterns");
  });
});

// ---------------------------------------------------------------------------
// extractUrlsFromRouter (inline builder support)
// ---------------------------------------------------------------------------

describe("extractUrlsFromRouter", () => {
  it("returns variable kind for .routes(identifier)", () => {
    const code = `export const router = createRouter().routes(urlpatterns);`;
    const result = extractUrlsFromRouter(code);
    expect(result).toEqual({ kind: "variable", name: "urlpatterns" });
  });

  it("returns variable kind for urls: identifier", () => {
    const code = `export const router = createRouter({ urls: urlpatterns });`;
    const result = extractUrlsFromRouter(code);
    expect(result).toEqual({ kind: "variable", name: "urlpatterns" });
  });

  it("returns inline kind for .routes(arrow function)", () => {
    const code = `
export const router = createRouter({ document: Document }).routes(({ path }) => [
  path("/", HomePage, { name: "home" }),
  path("/about", AboutPage, { name: "about" }),
]);
`;
    const result = extractUrlsFromRouter(code);
    expect(result?.kind).toBe("inline");
    expect(result!.kind === "inline" && result!.block).toContain(
      'path("/", HomePage',
    );
    expect(result!.kind === "inline" && result!.block).toContain(
      'path("/about"',
    );
  });

  it("returns inline kind for urls: arrow function", () => {
    const code = `
export const router = createRouter({
  document: Document,
  urls: ({ path, layout }) => [
    path("/", HomePage, { name: "home" }),
  ],
});
`;
    const result = extractUrlsFromRouter(code);
    expect(result?.kind).toBe("inline");
    expect(result!.kind === "inline" && result!.block).toContain(
      'path("/", HomePage',
    );
  });

  it("returns inline kind for chained .middleware().routes(arrow)", () => {
    const code = `
export const router = createRouter<AppEnv>({
  document: Document,
}).use(authMiddleware).routes(({ path }) => [
  path("/dashboard", Dashboard, { name: "dashboard" }),
]);
`;
    const result = extractUrlsFromRouter(code);
    expect(result?.kind).toBe("inline");
    expect(result!.kind === "inline" && result!.block).toContain(
      'path("/dashboard"',
    );
  });

  it("returns null for no createRouter call", () => {
    const code = `const x = someFunction().routes(patterns);`;
    expect(extractUrlsFromRouter(code)).toBeNull();
  });

  // Variable-held builders are a known gap: the extractor sees the identifier
  // and falls into the variable branch, but same-file resolution only matches
  // `const x = urls(...)`, not `const x = (helpers) => [...]`.
  // Runtime discovery still generates correct gen files at build time.
  it.todo(
    "returns inline kind for .routes(variable) where variable is an arrow function",
  );
  it.todo(
    "returns inline kind for urls: variable where variable is an arrow function",
  );
});

// ---------------------------------------------------------------------------
// extractBasenameFromRouter
// ---------------------------------------------------------------------------

describe("extractBasenameFromRouter", () => {
  it("extracts basename from createRouter({ basename: '/admin' })", () => {
    const code = `export const router = createRouter({ basename: "/admin" }).routes(patterns);`;
    expect(extractBasenameFromRouter(code)).toBe("/admin");
  });

  it("extracts basename alongside other options", () => {
    const code = `export const router = createRouter({ basename: "/v2", document: Doc }).routes(patterns);`;
    expect(extractBasenameFromRouter(code)).toBe("/v2");
  });

  it("returns undefined when no basename is set", () => {
    const code = `export const router = createRouter({ document: Doc }).routes(patterns);`;
    expect(extractBasenameFromRouter(code)).toBeUndefined();
  });

  it("returns undefined when createRouter has no options", () => {
    const code = `export const router = createRouter().routes(patterns);`;
    expect(extractBasenameFromRouter(code)).toBeUndefined();
  });

  it("ignores basename in non-createRouter calls", () => {
    const code = `const config = someFunction({ basename: "/admin" });`;
    expect(extractBasenameFromRouter(code)).toBeUndefined();
  });

  // Variable-held basenames are a known gap: the extractor only recognizes
  // string literals, not identifier references. Runtime discovery still
  // generates correct gen files at build time.
  it.todo(
    "extracts basename from variable reference (e.g. basename: BASENAME)",
  );
});
