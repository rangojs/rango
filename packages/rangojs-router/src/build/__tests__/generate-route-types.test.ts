import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { writeCombinedRouteTypes, generateRouteTypesSource } from "../generate-route-types";

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
