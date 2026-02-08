import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const DIST = path.resolve("dist");

/**
 * Build output validation for pre-rendered routes.
 *
 * These tests inspect the filesystem directly (no server needed).
 * They verify:
 *   1. Handler code is evicted from client and SSR bundles
 *   2. Handler code is isolated in the __prerender-handlers chunk
 *   3. Flight files follow the correct folder structure
 *   4. Flight file JSON has the expected shape
 *   5. Metadata files (prefixes.json, routes.json) are well-formed
 */

// -- Helpers --

function readAllFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
}

function concatBundleContents(dir: string): string {
  return readAllFiles(dir)
    .map((f) => fs.readFileSync(path.join(dir, f), "utf-8"))
    .join("\n");
}

/** Find the version-hash directory under dist/static/ */
function findVersionDir(): string {
  const staticDir = path.join(DIST, "static");
  const entries = fs.readdirSync(staticDir);
  const versionDir = entries.find((e) => e.startsWith("__"));
  expect(versionDir).toBeTruthy();
  return path.join(staticDir, versionDir!);
}

// -- Handler eviction tests --

test.describe("handler eviction", () => {
  let clientBundle: string;
  let ssrBundle: string;
  let prerenderHandlersBundle: string;

  test.beforeAll(() => {
    clientBundle = concatBundleContents(path.join(DIST, "client/assets"));
    ssrBundle = concatBundleContents(path.join(DIST, "rsc/ssr/assets"));

    const rscAssets = readAllFiles(path.join(DIST, "rsc/assets"));
    const handlerFile = rscAssets.find((f) => f.startsWith("__prerender-handlers"));
    expect(handlerFile).toBeTruthy();
    prerenderHandlersBundle = fs.readFileSync(
      path.join(DIST, "rsc/assets", handlerFile!),
      "utf-8",
    );
  });

  test("prerender-handlers chunk exists in RSC bundle", () => {
    expect(prerenderHandlersBundle.length).toBeGreaterThan(0);
  });

  test("parseFrontmatter is not in client bundle", () => {
    expect(clientBundle).not.toContain("parseFrontmatter");
  });

  test("parseFrontmatter is not in SSR bundle", () => {
    expect(ssrBundle).not.toContain("parseFrontmatter");
  });

  test("parseFrontmatter is in prerender-handlers chunk", () => {
    expect(prerenderHandlersBundle).toContain("parseFrontmatter");
  });

  // Markdown files are inlined via import.meta.glob(".../*.md", { query: "?raw", eager: true }).
  // The raw content (frontmatter + body) must only exist in the prerender-handlers chunk,
  // never in client or SSR bundles. One test per .md file so failures pinpoint which leaked.

  // -- what-is-prerendering.md --

  test("what-is-prerendering.md frontmatter not in client bundle", () => {
    expect(clientBundle).not.toContain("title: What is Pre-rendering?");
    expect(clientBundle).not.toContain("publishedAt: 2025-06-01");
  });

  test("what-is-prerendering.md frontmatter not in SSR bundle", () => {
    expect(ssrBundle).not.toContain("title: What is Pre-rendering?");
    expect(ssrBundle).not.toContain("publishedAt: 2025-06-01");
  });

  test("what-is-prerendering.md body not in client bundle", () => {
    expect(clientBundle).not.toContain(
      "Pre-rendering is a technique where route segments",
    );
    expect(clientBundle).not.toContain(
      "No build-only deps in production",
    );
  });

  test("what-is-prerendering.md body not in SSR bundle", () => {
    expect(ssrBundle).not.toContain(
      "Pre-rendering is a technique where route segments",
    );
    expect(ssrBundle).not.toContain(
      "No build-only deps in production",
    );
  });

  // -- static-params.md --

  test("static-params.md frontmatter not in client bundle", () => {
    expect(clientBundle).not.toContain("title: Static Params with getParams");
    expect(clientBundle).not.toContain("publishedAt: 2025-07-01");
  });

  test("static-params.md frontmatter not in SSR bundle", () => {
    expect(ssrBundle).not.toContain("title: Static Params with getParams");
    expect(ssrBundle).not.toContain("publishedAt: 2025-07-01");
  });

  test("static-params.md body not in client bundle", () => {
    expect(clientBundle).not.toContain(
      "the pre-render handler needs to know which slugs to render",
    );
    expect(clientBundle).not.toContain(
      "each parameter set produces a separate Flight payload",
    );
  });

  test("static-params.md body not in SSR bundle", () => {
    expect(ssrBundle).not.toContain(
      "the pre-render handler needs to know which slugs to render",
    );
    expect(ssrBundle).not.toContain(
      "each parameter set produces a separate Flight payload",
    );
  });

  // -- prerender-vs-cache.md --

  test("prerender-vs-cache.md frontmatter not in client bundle", () => {
    expect(clientBundle).not.toContain("title: Pre-rendering vs Caching");
    expect(clientBundle).not.toContain("publishedAt: 2025-06-15");
  });

  test("prerender-vs-cache.md frontmatter not in SSR bundle", () => {
    expect(ssrBundle).not.toContain("title: Pre-rendering vs Caching");
    expect(ssrBundle).not.toContain("publishedAt: 2025-06-15");
  });

  test("prerender-vs-cache.md body not in client bundle", () => {
    expect(clientBundle).not.toContain(
      "Caching and pre-rendering both store RSC Flight payloads",
    );
    expect(clientBundle).not.toContain(
      "build-only code (markdown parsers, file system reads)",
    );
  });

  test("prerender-vs-cache.md body not in SSR bundle", () => {
    expect(ssrBundle).not.toContain(
      "Caching and pre-rendering both store RSC Flight payloads",
    );
    expect(ssrBundle).not.toContain(
      "build-only code (markdown parsers, file system reads)",
    );
  });

  // Positive check: the content IS in the prerender-handlers chunk

  test("all markdown content is in prerender-handlers chunk", () => {
    // what-is-prerendering.md
    expect(prerenderHandlersBundle).toContain(
      "Pre-rendering is a technique where route segments",
    );
    // static-params.md
    expect(prerenderHandlersBundle).toContain(
      "the pre-render handler needs to know which slugs to render",
    );
    // prerender-vs-cache.md
    expect(prerenderHandlersBundle).toContain(
      "Caching and pre-rendering both store RSC Flight payloads",
    );
  });

  test("content/articles glob pattern is not in client bundle", () => {
    expect(clientBundle).not.toContain("content/articles");
  });

  test("content/articles glob pattern is not in SSR bundle", () => {
    expect(ssrBundle).not.toContain("content/articles");
  });
});

// -- Flight file structure tests --

test.describe("flight file structure", () => {
  let versionDir: string;
  let prerenderDir: string;

  test.beforeAll(() => {
    versionDir = findVersionDir();
    prerenderDir = path.join(versionDir, "prerender");
  });

  test("version-hash directory exists under dist/static/", () => {
    const staticDir = path.join(DIST, "static");
    const entries = fs.readdirSync(staticDir);
    const versionDirs = entries.filter((e) => e.startsWith("__"));
    expect(versionDirs).toHaveLength(1);
    // Version hash is a hex string prefixed with __
    expect(versionDirs[0]).toMatch(/^__[a-f0-9]+$/);
  });

  test("prerender directory contains expected route folders", () => {
    const folders = fs.readdirSync(prerenderDir);
    expect(folders).toContain("articles.index");
    expect(folders).toContain("articles.detail");
  });

  test("static route (articles.index) has _.flight file", () => {
    const indexDir = path.join(prerenderDir, "articles.index");
    const files = fs.readdirSync(indexDir);
    expect(files).toEqual(["_.flight"]);
  });

  test("dynamic route (articles.detail) has one .flight per param combination", () => {
    const detailDir = path.join(prerenderDir, "articles.detail");
    const files = fs.readdirSync(detailDir).sort();
    // 3 articles: what-is-prerendering, static-params, prerender-vs-cache
    expect(files).toHaveLength(3);
    // Each file is an 8-char hex hash + .flight
    for (const file of files) {
      expect(file).toMatch(/^[a-f0-9]{8}\.flight$/);
    }
  });

  test("flight file JSON has segments and handles", () => {
    const flightPath = path.join(
      prerenderDir,
      "articles.index",
      "_.flight",
    );
    const data = JSON.parse(fs.readFileSync(flightPath, "utf-8"));

    expect(data).toHaveProperty("segments");
    expect(data).toHaveProperty("handles");
    expect(Array.isArray(data.segments)).toBe(true);
    expect(data.segments.length).toBeGreaterThan(0);
  });

  test("each segment has encoded string and metadata", () => {
    const flightPath = path.join(
      prerenderDir,
      "articles.index",
      "_.flight",
    );
    const data = JSON.parse(fs.readFileSync(flightPath, "utf-8"));

    for (const segment of data.segments) {
      expect(segment).toHaveProperty("encoded");
      expect(typeof segment.encoded).toBe("string");
      expect(segment.encoded.length).toBeGreaterThan(0);

      expect(segment).toHaveProperty("metadata");
      expect(segment.metadata).toHaveProperty("id");
      expect(segment.metadata).toHaveProperty("type");
      expect(["layout", "route", "parallel"]).toContain(segment.metadata.type);
    }
  });

  test("articles.index flight has layout, parallel, and route segments", () => {
    const flightPath = path.join(
      prerenderDir,
      "articles.index",
      "_.flight",
    );
    const data = JSON.parse(fs.readFileSync(flightPath, "utf-8"));
    const types = data.segments.map((s: any) => s.metadata.type);

    expect(types).toContain("layout");
    expect(types).toContain("route");
    expect(types).toContain("parallel");
  });

  test("articles.detail flight has layout and route segments but no parallel", () => {
    const detailDir = path.join(prerenderDir, "articles.detail");
    const files = fs.readdirSync(detailDir);
    const data = JSON.parse(
      fs.readFileSync(path.join(detailDir, files[0]), "utf-8"),
    );
    const types = data.segments.map((s: any) => s.metadata.type);

    expect(types).toContain("layout");
    expect(types).toContain("route");
    // @stats parallel is scoped to index only
    expect(types).not.toContain("parallel");
  });

  test("handles object has entries matching segment IDs", () => {
    const flightPath = path.join(
      prerenderDir,
      "articles.index",
      "_.flight",
    );
    const data = JSON.parse(fs.readFileSync(flightPath, "utf-8"));
    const segmentIds = data.segments.map((s: any) => s.metadata.id);
    const handleKeys = Object.keys(data.handles);

    // Every segment ID should have a corresponding handles entry
    for (const id of segmentIds) {
      expect(handleKeys).toContain(id);
    }
  });
});

// -- Metadata file tests --

test.describe("prerender metadata files", () => {
  let versionDir: string;

  test.beforeAll(() => {
    versionDir = findVersionDir();
  });

  test("prefixes.json exists and maps /articles prefix", () => {
    const data = JSON.parse(
      fs.readFileSync(path.join(versionDir, "prefixes.json"), "utf-8"),
    );

    expect(data).toHaveProperty("/articles");
    expect(data["/articles"]).toHaveProperty("routes");
    expect(data["/articles"].routes).toContain("articles.index");
    expect(data["/articles"].routes).toContain("articles.detail");
  });

  test("prefixes.json has correct prefix properties", () => {
    const data = JSON.parse(
      fs.readFileSync(path.join(versionDir, "prefixes.json"), "utf-8"),
    );

    const articlesPrefix = data["/articles"];
    expect(articlesPrefix.staticPrefix).toBe("/articles");
    expect(articlesPrefix.fullPrefix).toBe("/articles");
    expect(articlesPrefix.namePrefix).toBe("articles");
  });

  test("routes.json maps all prerendered route names to URL patterns", () => {
    const data = JSON.parse(
      fs.readFileSync(path.join(versionDir, "routes.json"), "utf-8"),
    );

    expect(data["articles.index"]).toBe("/articles");
    expect(data["articles.detail"]).toBe("/articles/:slug");
  });

  test("routes.json contains non-prerendered routes too", () => {
    const data = JSON.parse(
      fs.readFileSync(path.join(versionDir, "routes.json"), "utf-8"),
    );

    // routes.json is the full route manifest, not just prerendered routes
    expect(data).toHaveProperty("home");
    expect(data).toHaveProperty("counter");
    expect(data).toHaveProperty("about");
  });
});
