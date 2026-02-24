import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
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

  it("should create .named-routes.gen.ts with correct routes", () => {
    const urlsPath = join(tempDir, "urls.ts");
    const routerPath = join(tempDir, "router.ts");
    writeFileSync(urlsPath, urlsSource([
      { pattern: "/", name: "index" },
      { pattern: "/about", name: "about" },
    ]));
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
    writeFileSync(urlsPath, urlsSource([
      { pattern: "/", name: "index" },
    ]));
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
    writeFileSync(urlsPath, urlsSource([
      { pattern: "/", name: "index" },
      { pattern: "/about", name: "about" },
    ]));
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

  it("should allow growth when preserveIfLarger is set", () => {
    const urlsPath = join(tempDir, "urls.ts");
    const routerPath = join(tempDir, "router.ts");

    // Static parser will find 3 routes
    writeFileSync(urlsPath, urlsSource([
      { pattern: "/", name: "index" },
      { pattern: "/about", name: "about" },
      { pattern: "/contact", name: "contact" },
    ]));
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
    writeFileSync(urlsPath, urlsSource([
      { pattern: "/", name: "index" },
      { pattern: "/new-page", name: "newPage" },
    ]));
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
    writeFileSync(urlsPath, urlsSource([
      { pattern: "/", name: "index" },
      { pattern: "/about", name: "about" },
    ]));
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

    writeFileSync(urlsAPath, urlsSource([
      { pattern: "/", name: "index" },
    ]));
    writeFileSync(routerAPath, routerSource("./urlsA.js"));

    writeFileSync(urlsBPath, urlsSource([
      { pattern: "/dashboard", name: "dashboard" },
      { pattern: "/settings", name: "settings" },
    ]));
    writeFileSync(routerBPath, routerSource("./urlsB.js"));

    // Pre-seed routerA's gen file with more routes than static parser finds
    const genAPath = genPath(routerAPath);
    writeFileSync(genAPath, generateRouteTypesSource({
      index: "/",
      about: "/about",
      contact: "/contact",
    }));

    // routerB has no gen file yet
    const genBPath = genPath(routerBPath);
    expect(existsSync(genBPath)).toBe(false);

    writeCombinedRouteTypes(tempDir, [routerAPath, routerBPath], { preserveIfLarger: true });

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
      '  detail: "/:slug",'
    );
  });

  it("formats routes with search as objects", () => {
    expect(
      formatRouteEntry("search", "/search", undefined, { q: "string" })
    ).toBe('  search: { path: "/search", search: { q: "string" } },');
  });

  it("formats routes with params and search as objects with search only", () => {
    expect(
      formatRouteEntry("items", "/:id/items", { id: "string" }, { page: "number?" })
    ).toBe(
      '  items: { path: "/:id/items", search: { page: "number?" } },'
    );
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
    const itemsEntry = 'items: { path: "/:id/items", search: { page: "number?" } }';
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
    writeFileSync(apiPath, `import { urls } from "@rangojs/router";
const handler = () => null;
export const apiUrls = urls(({ path }) => [
  path("/users", handler, { name: "users" }),
  path("/posts", handler, { name: "posts" }),
]);
`);

    // Main module that includes the sub-module
    const mainPath = join(tempDir, "urls.ts");
    writeFileSync(mainPath, `import { urls } from "@rangojs/router";
import { apiUrls } from "./api-urls.js";
const handler = () => null;
export const patterns = urls(({ path, include }) => [
  path("/", handler, { name: "index" }),
  include("/api", apiUrls, { name: "api" }),
]);
`);

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

  it("follows multi-level includes (A -> B -> C)", () => {
    // Level C: leaf routes
    const cPath = join(tempDir, "c-urls.ts");
    writeFileSync(cPath, `import { urls } from "@rangojs/router";
const handler = () => null;
export const cUrls = urls(({ path }) => [
  path("/leaf", handler, { name: "leaf" }),
]);
`);

    // Level B: includes C
    const bPath = join(tempDir, "b-urls.ts");
    writeFileSync(bPath, `import { urls } from "@rangojs/router";
import { cUrls } from "./c-urls.js";
const handler = () => null;
export const bUrls = urls(({ path, include }) => [
  path("/mid", handler, { name: "mid" }),
  include("/nested", cUrls, { name: "nested" }),
]);
`);

    // Level A: includes B
    const aPath = join(tempDir, "urls.ts");
    writeFileSync(aPath, `import { urls } from "@rangojs/router";
import { bUrls } from "./b-urls.js";
const handler = () => null;
export const patterns = urls(({ path, include }) => [
  path("/", handler, { name: "index" }),
  include("/b", bUrls, { name: "b" }),
]);
`);

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

    writeFileSync(aPath, `import { urls } from "@rangojs/router";
import { bUrls } from "./b-urls.js";
const handler = () => null;
export const aUrls = urls(({ path, include }) => [
  path("/a-route", handler, { name: "aRoute" }),
  include("/b", bUrls, { name: "b" }),
]);
`);

    writeFileSync(bPath, `import { urls } from "@rangojs/router";
import { aUrls } from "./a-urls.js";
const handler = () => null;
export const bUrls = urls(({ path, include }) => [
  path("/b-route", handler, { name: "bRoute" }),
  include("/a", aUrls, { name: "a" }),
]);
`);

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
      expect.stringContaining("Circular include detected")
    );

    warnSpy.mockRestore();
  });

  it("includes params from sub-module parameterized routes", () => {
    const subPath = join(tempDir, "detail-urls.ts");
    writeFileSync(subPath, `import { urls } from "@rangojs/router";
const handler = () => null;
export const detailUrls = urls(({ path }) => [
  path("/:slug", handler, { name: "detail" }),
]);
`);

    const mainPath = join(tempDir, "urls.ts");
    writeFileSync(mainPath, `import { urls } from "@rangojs/router";
import { detailUrls } from "./detail-urls.js";
const handler = () => null;
export const patterns = urls(({ path, include }) => [
  path("/", handler, { name: "index" }),
  include("/docs", detailUrls, { name: "docs" }),
]);
`);

    writePerModuleRouteTypesForFile(mainPath);

    const genPath = mainPath.replace(/\.ts$/, ".gen.ts");
    const content = readFileSync(genPath, "utf-8");

    // The included route should have the combined prefix + pattern with param
    expect(content).toContain('"docs.detail": "/docs/:slug",');
  });

  it("falls back to direct extraction when no urls() variable exists", () => {
    // File with path() calls but no urls() variable assignment
    const filePath = join(tempDir, "urls.ts");
    writeFileSync(filePath, `import { urls } from "@rangojs/router";
const handler = () => null;
export default urls(({ path }) => [
  path("/", handler, { name: "index" }),
]);
`);

    writePerModuleRouteTypesForFile(filePath);

    const genPath = filePath.replace(/\.ts$/, ".gen.ts");
    expect(existsSync(genPath)).toBe(true);
    const content = readFileSync(genPath, "utf-8");
    expect(content).toContain('index: "/"');
  });

  it("handles same-file includes (no import needed)", () => {
    const filePath = join(tempDir, "urls.ts");
    writeFileSync(filePath, `import { urls } from "@rangojs/router";
const handler = () => null;
const apiUrls = urls(({ path }) => [
  path("/users", handler, { name: "users" }),
]);
export const patterns = urls(({ path, include }) => [
  path("/", handler, { name: "index" }),
  include("/api", apiUrls, { name: "api" }),
]);
`);

    writePerModuleRouteTypesForFile(filePath);

    const genPath = filePath.replace(/\.ts$/, ".gen.ts");
    const content = readFileSync(genPath, "utf-8");

    expect(content).toContain('index: "/"');
    expect(content).toContain("api.users");
    expect(content).toContain("/api/users");
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
`
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
`
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
`
    );
    writeFileSync(
      join(dir, "urls.tsx"),
      `import { urls } from "@rangojs/router";
const handler = () => null;
export const urlpatterns = urls(({ path, include }) => [
  path("/", handler, { name: "home" }),
  include("/ghost", ghostUrls, { name: "ghost" }),
]);
`
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

  it("extracts from .routes(() => varName) chain", () => {
    const code = `
import { createRouter } from "@rangojs/router";
import { urlpatterns } from "./urls.js";
export const router = createRouter().routes(() => urlpatterns);
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

  it("extracts from createRouter({ urls: () => varName })", () => {
    const code = `
import { createRouter } from "@rangojs/router";
import { urlpatterns } from "./urls.js";
export const router = createRouter({ urls: () => urlpatterns, document: Document });
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
