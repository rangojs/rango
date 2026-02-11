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
 *   3. Prerender assets (__prerender-manifest.js, __pr-*.js) have correct structure
 *   4. Metadata files (prefixes.json, routes.json) are well-formed
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

// -- Prerender asset structure tests --

test.describe("prerender asset structure", () => {
  const RSC_DIR = path.join(DIST, "rsc");
  const RSC_ASSETS_DIR = path.join(RSC_DIR, "assets");

  test("__prerender-manifest.js exists", () => {
    const manifestPath = path.join(RSC_DIR, "__prerender-manifest.js");
    expect(fs.existsSync(manifestPath)).toBe(true);
  });

  test("__prerender-manifest.js references articles routes", () => {
    const manifestCode = fs.readFileSync(
      path.join(RSC_DIR, "__prerender-manifest.js"),
      "utf-8",
    );

    // Static route uses "_" param hash
    expect(manifestCode).toContain('"articles.index/_"');

    // Dynamic route uses hex param hashes
    expect(manifestCode).toMatch(/"articles\.detail\/[a-f0-9]+"/);

    // References __pr-*.js asset imports
    expect(manifestCode).toMatch(/import\("\.\/assets\/__pr-[a-f0-9]+\.js"\)/);
  });

  test("__pr-*.js asset files exist and have correct count", () => {
    const prFiles = fs.readdirSync(RSC_ASSETS_DIR).filter(
      (f) => f.startsWith("__pr-") && f.endsWith(".js"),
    );
    // At least articles.index (1) + articles.detail (3 articles) = 4 entries
    expect(prFiles.length).toBeGreaterThanOrEqual(4);
    // Each file follows __pr-<8hexchars>.js naming
    for (const file of prFiles) {
      expect(file).toMatch(/^__pr-[a-f0-9]{8}\.js$/);
    }
  });

  test("__pr-*.js asset files export correct shape", () => {
    const prFiles = fs.readdirSync(RSC_ASSETS_DIR).filter(
      (f) => f.startsWith("__pr-") && f.endsWith(".js"),
    );

    for (const file of prFiles) {
      const content = fs.readFileSync(path.join(RSC_ASSETS_DIR, file), "utf-8");
      expect(content).toContain("export default");

      const match = content.match(/export default\s+({[\s\S]*});\s*$/);
      expect(match).toBeTruthy();
      const data = JSON.parse(match![1]);

      expect(Array.isArray(data.segments)).toBe(true);
      expect(data.segments.length).toBeGreaterThan(0);
      expect(typeof data.handles).toBe("object");
    }
  });

  test("asset segments have encoded string and metadata", () => {
    const prFiles = fs.readdirSync(RSC_ASSETS_DIR).filter(
      (f) => f.startsWith("__pr-") && f.endsWith(".js"),
    );
    // Check first asset file
    const content = fs.readFileSync(
      path.join(RSC_ASSETS_DIR, prFiles[0]),
      "utf-8",
    );
    const match = content.match(/export default\s+({[\s\S]*});\s*$/);
    const data = JSON.parse(match![1]);

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

  test("RSC entry imports __prerender-manifest.js", () => {
    const rscIndex = fs.readFileSync(path.join(RSC_DIR, "index.js"), "utf-8");
    expect(rscIndex).toContain("__prerender-manifest.js");
    expect(rscIndex).toContain("__PRERENDER_MANIFEST");
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
