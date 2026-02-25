import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  expectNoReload,
  testId,
} from "./helper";

test.describe.configure({ mode: "serial" });

// ==========================================================================
// Dev mode: Static behaves as a normal handler (runs live)
// Tests all three DSL positions: layout(), path(), parallel()
// ==========================================================================

test.describe("static-handler (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  // -- layout() with Static --

  test("static layout renders on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content"));
    await waitForHydration(page);

    await expect(testId(page, "static-docs-layout")).toBeVisible();
    await expect(testId(page, "static-docs-nav")).toBeVisible();
    await expect(testId(page, "static-docs-index")).toBeVisible();
  });

  test("static layout wraps dynamic child pages", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content/getting-started"));
    await waitForHydration(page);

    // Layout wraps the dynamic page
    await expect(testId(page, "static-docs-layout")).toBeVisible();
    await expect(testId(page, "static-docs-nav")).toBeVisible();
    await expect(testId(page, "docs-page")).toBeVisible();
    await expect(testId(page, "docs-page-title")).toHaveText(
      "Doc: getting-started",
    );
  });

  test("static layout nav links render from build-time data", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content"));
    await waitForHydration(page);

    await expect(testId(page, "docs-nav-getting-started")).toBeVisible();
    await expect(testId(page, "docs-nav-configuration")).toBeVisible();
    await expect(testId(page, "docs-nav-deployment")).toBeVisible();
  });

  // -- path() with Static --

  test("static path renders index page content", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content"));
    await waitForHydration(page);

    await expect(testId(page, "static-docs-index")).toBeVisible();
    await expect(testId(page, "static-index-info")).toHaveText(
      /statically rendered at build time/,
    );
    await expect(testId(page, "static-docs-list")).toBeVisible();
  });

  // -- parallel() with Static --

  test("static parallel slot renders TOC sidebar", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content/getting-started"));
    await waitForHydration(page);

    await expect(testId(page, "static-toc-sidebar")).toBeVisible();
    await expect(testId(page, "static-toc-list")).toBeVisible();
    await expect(testId(page, "toc-item-getting-started")).toBeVisible();
    await expect(testId(page, "toc-item-configuration")).toBeVisible();
    await expect(testId(page, "toc-item-deployment")).toBeVisible();
  });

  test("static parallel slot not present on index (scoped to :slug)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content"));
    await waitForHydration(page);

    // TOC is inside the :slug route, not the index route
    await expect(testId(page, "static-toc-sidebar")).not.toBeVisible();
  });

  // -- Handles (breadcrumbs) with Static layout --

  test("static layout pushes breadcrumb handle data", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content"));
    await waitForHydration(page);

    await expect(testId(page, "breadcrumbs")).toBeVisible();
    await expect(testId(page, "breadcrumb-docs")).toBeVisible();
  });

  // -- Client navigation --

  test("client navigation preserves static layout", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    // Navigate to a doc page via nav link
    await testId(page, "docs-nav-configuration").click();
    await expect(testId(page, "docs-page-title")).toHaveText(
      "Doc: configuration",
    );

    // Layout preserved
    await expect(testId(page, "static-docs-layout")).toBeVisible();
    await expect(testId(page, "static-docs-nav")).toBeVisible();

    // Parallel TOC should appear on slug page
    await expect(testId(page, "static-toc-sidebar")).toBeVisible();
  });

  test("client navigation between slug pages preserves layout and parallel", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content/getting-started"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    await expect(testId(page, "static-toc-sidebar")).toBeVisible();

    // Navigate to another slug
    await testId(page, "docs-nav-deployment").click();
    await expect(testId(page, "docs-page-title")).toHaveText("Doc: deployment");

    // Layout and parallel slot still visible
    await expect(testId(page, "static-docs-layout")).toBeVisible();
    await expect(testId(page, "static-toc-sidebar")).toBeVisible();
  });

  test("client navigation from static-content to docs shows docs content", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content"));
    await waitForHydration(page);

    // Verify we're on static-content
    await expect(testId(page, "static-docs-index")).toBeVisible();

    // Navigate to docs via nav link
    await testId(page, "nav-docs").click();

    // Should show docs content, not static-content
    await expect(testId(page, "docs-index")).toBeVisible();
    await expect(testId(page, "static-docs-index")).not.toBeVisible();
  });
});

// ==========================================================================
// Production: static handler renders build-time content
// Tests all three DSL positions: layout(), path(), parallel()
// ==========================================================================

test.describe("static-handler (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  // -- layout() with Static --

  test("static layout renders on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content"));
    await waitForHydration(page);

    await expect(testId(page, "static-docs-layout")).toBeVisible();
    await expect(testId(page, "static-docs-nav")).toBeVisible();
    await expect(testId(page, "static-docs-index")).toBeVisible();
  });

  test("static layout wraps dynamic child on direct visit", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content/getting-started"));
    await waitForHydration(page);

    await expect(testId(page, "static-docs-layout")).toBeVisible();
    await expect(testId(page, "static-docs-nav")).toBeVisible();
    await expect(testId(page, "docs-page")).toBeVisible();
    await expect(testId(page, "docs-page-title")).toHaveText(
      "Doc: getting-started",
    );
  });

  test("static layout nav links render from build-time data", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content"));
    await waitForHydration(page);

    await expect(testId(page, "docs-nav-getting-started")).toBeVisible();
    await expect(testId(page, "docs-nav-configuration")).toBeVisible();
    await expect(testId(page, "docs-nav-deployment")).toBeVisible();
  });

  // -- path() with Static --

  test("static path renders index page content", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content"));
    await waitForHydration(page);

    await expect(testId(page, "static-docs-index")).toBeVisible();
    await expect(testId(page, "static-index-info")).toHaveText(
      /statically rendered at build time/,
    );
    await expect(testId(page, "static-docs-list")).toBeVisible();
    // Index-level links from build data
    await expect(testId(page, "docs-index-link-getting-started")).toBeVisible();
    await expect(testId(page, "docs-index-link-configuration")).toBeVisible();
    await expect(testId(page, "docs-index-link-deployment")).toBeVisible();
  });

  // -- parallel() with Static --

  test("static parallel slot renders TOC sidebar on slug page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content/getting-started"));
    await waitForHydration(page);

    await expect(testId(page, "static-toc-sidebar")).toBeVisible();
    await expect(testId(page, "static-toc-list")).toBeVisible();
    await expect(testId(page, "toc-item-getting-started")).toBeVisible();
    await expect(testId(page, "toc-item-configuration")).toBeVisible();
    await expect(testId(page, "toc-item-deployment")).toBeVisible();
  });

  test("static parallel slot not present on index page", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content"));
    await waitForHydration(page);

    await expect(testId(page, "static-toc-sidebar")).not.toBeVisible();
  });

  test("static parallel renders on different slug", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content/configuration"));
    await waitForHydration(page);

    await expect(testId(page, "static-toc-sidebar")).toBeVisible();
    await expect(testId(page, "docs-page-title")).toHaveText(
      "Doc: configuration",
    );
  });

  test("static layout sidebar renders on direct visit to slug page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content/configuration"));
    await waitForHydration(page);

    await expect(testId(page, "static-docs-layout")).toBeVisible();
    await expect(testId(page, "static-docs-nav")).toBeVisible();
    await expect(testId(page, "docs-nav-getting-started")).toBeVisible();
    await expect(testId(page, "docs-nav-configuration")).toBeVisible();
    await expect(testId(page, "docs-nav-deployment")).toBeVisible();
  });

  // -- Handles (breadcrumbs) with Static layout --

  test("static layout pushes breadcrumb handle data on direct visit", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content"));
    await waitForHydration(page);

    // Breadcrumbs component should render the "Docs" breadcrumb
    // pushed by the Static DocsNavLayout handler
    await expect(testId(page, "breadcrumbs")).toBeVisible();
    await expect(testId(page, "breadcrumb-docs")).toBeVisible();
  });

  test("static layout breadcrumb persists across client navigation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content"));
    await waitForHydration(page);

    await expect(testId(page, "breadcrumb-docs")).toBeVisible();

    await using __ = await expectNoReload(page);

    // Navigate to slug page — layout breadcrumb should persist
    await testId(page, "docs-nav-getting-started").click();
    await expect(testId(page, "docs-page")).toBeVisible();
    await expect(testId(page, "breadcrumb-docs")).toBeVisible();
  });

  // -- Client navigation (covers all three) --

  test("client navigation to static content from another page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/counter"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    await testId(page, "nav-static-content").click();
    await expect(testId(page, "static-docs-layout")).toBeVisible();
    await expect(testId(page, "static-docs-index")).toBeVisible();
  });

  test("client navigation from index to slug shows parallel slot", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content"));
    await waitForHydration(page);

    // No TOC on index
    await expect(testId(page, "static-toc-sidebar")).not.toBeVisible();

    await using __ = await expectNoReload(page);

    // Navigate to slug page
    await testId(page, "docs-nav-getting-started").click();
    await expect(testId(page, "docs-page")).toBeVisible();

    // TOC should now appear
    await expect(testId(page, "static-toc-sidebar")).toBeVisible();
    // Layout still present
    await expect(testId(page, "static-docs-layout")).toBeVisible();
  });

  test("client navigation between slug pages preserves layout and parallel", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content/getting-started"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    await expect(testId(page, "static-toc-sidebar")).toBeVisible();

    // Navigate to another slug
    await testId(page, "docs-nav-deployment").click();
    await expect(testId(page, "docs-page-title")).toHaveText("Doc: deployment");

    // Both layout and parallel slot preserved
    await expect(testId(page, "static-docs-layout")).toBeVisible();
    await expect(testId(page, "static-toc-sidebar")).toBeVisible();
  });

  test("back navigation preserves static layout", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    // Navigate to slug
    await testId(page, "docs-nav-getting-started").click();
    await expect(testId(page, "docs-page")).toBeVisible();

    // Go back
    await page.goBack();
    await expect(testId(page, "static-docs-index")).toBeVisible();
    await expect(testId(page, "static-docs-layout")).toBeVisible();
  });

  test("cross-route navigation away from static content and back", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content/configuration"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    // Navigate away to a completely different section
    await testId(page, "nav-counter").click();
    await expect(page.locator("h1")).toContainText("Counter");

    // Navigate back to static content
    await testId(page, "nav-static-content").click();
    await expect(testId(page, "static-docs-layout")).toBeVisible();
    await expect(testId(page, "static-docs-index")).toBeVisible();
  });

  test("client navigation from static-content to docs shows docs content", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content"));
    await waitForHydration(page);

    // Verify we're on static-content
    await expect(testId(page, "static-docs-index")).toBeVisible();

    // Navigate to docs via nav link
    await testId(page, "nav-docs").click();

    // Should show docs content, not static-content
    await expect(testId(page, "docs-index")).toBeVisible();
    await expect(testId(page, "static-docs-index")).not.toBeVisible();
  });
});

// ==========================================================================
// Production: verify Static is truly pre-rendered (timestamp frozen)
// If the handler runs live, the timestamp changes on each reload.
// ==========================================================================

test.describe("static-handler timestamp stability (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  // NOTE: BUILD_TIMESTAMP is a module-level constant, so it's stable across
  // requests even if the handler re-executes. These tests confirm module-level
  // constants work, but do NOT prove true pre-rendering.

  test("layout BUILD_TIMESTAMP is stable across reloads", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content"));
    await waitForHydration(page);

    const ts1 = await testId(page, "static-nav-build-time").textContent();

    await page.reload();
    await waitForHydration(page);

    const ts2 = await testId(page, "static-nav-build-time").textContent();

    expect(ts1).toBe(ts2);
  });

  test("path BUILD_TIMESTAMP is stable across reloads", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content"));
    await waitForHydration(page);

    const ts1 = await testId(page, "static-index-build-time").textContent();

    await page.reload();
    await waitForHydration(page);

    const ts2 = await testId(page, "static-index-build-time").textContent();

    expect(ts1).toBe(ts2);
  });

  test("parallel BUILD_TIMESTAMP is stable across reloads", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content/getting-started"));
    await waitForHydration(page);

    const ts1 = await testId(page, "static-toc-build-time").textContent();

    await page.reload();
    await waitForHydration(page);

    const ts2 = await testId(page, "static-toc-build-time").textContent();

    expect(ts1).toBe(ts2);
  });

  // These tests use Date.now() INSIDE the handler function, which changes
  // on every invocation. If the handler is truly pre-rendered, this value
  // would be frozen at build time. If running live, it changes per request.

  test("layout handler-time is stable across reloads (handler not re-executing)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content"));
    await waitForHydration(page);

    const ts1 = await testId(page, "static-nav-handler-time").textContent();

    await page.reload();
    await waitForHydration(page);

    const ts2 = await testId(page, "static-nav-handler-time").textContent();

    expect(ts1).toBe(ts2);
  });

  test("path handler-time is stable across reloads (handler not re-executing)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content"));
    await waitForHydration(page);

    const ts1 = await testId(page, "static-index-handler-time").textContent();

    await page.reload();
    await waitForHydration(page);

    const ts2 = await testId(page, "static-index-handler-time").textContent();

    expect(ts1).toBe(ts2);
  });

  test("parallel handler-time is stable across reloads (handler not re-executing)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-content/getting-started"));
    await waitForHydration(page);

    const ts1 = await testId(page, "static-toc-handler-time").textContent();

    await page.reload();
    await waitForHydration(page);

    const ts2 = await testId(page, "static-toc-handler-time").textContent();

    expect(ts1).toBe(ts2);
  });
});

// ==========================================================================
// Build output validation: bundle isolation
// ==========================================================================

test.describe("static-handler build output (production)", () => {
  const DIST = path.resolve("dist");

  let clientBundle: string;
  let ssrBundle: string;
  let staticHandlersBundle: string;

  test.beforeAll(() => {
    clientBundle = readAllFiles(path.join(DIST, "client/assets"))
      .map((f) => fs.readFileSync(path.join(DIST, "client/assets", f), "utf-8"))
      .join("\n");
    ssrBundle = readAllFiles(path.join(DIST, "rsc/ssr/assets"))
      .map((f) =>
        fs.readFileSync(path.join(DIST, "rsc/ssr/assets", f), "utf-8"),
      )
      .join("\n");

    const rscAssets = readAllFiles(path.join(DIST, "rsc/assets"));
    const handlerFile = rscAssets.find((f) =>
      f.startsWith("__static-handlers"),
    );
    expect(handlerFile).toBeTruthy();
    staticHandlersBundle = fs.readFileSync(
      path.join(DIST, "rsc/assets", handlerFile!),
      "utf-8",
    );
  });

  test("static-handlers chunk exists in RSC bundle", () => {
    expect(staticHandlersBundle.length).toBeGreaterThan(0);
  });

  test("static handler bodies are evicted from RSC bundle", () => {
    // Handler bodies are replaced with stubs after build-time rendering.
    // The original handler content strings should no longer be present.
    expect(staticHandlersBundle).not.toContain("Docs Navigation");
    expect(staticHandlersBundle).not.toContain("Table of Contents");
    // Stub objects should contain the brand marker
    expect(staticHandlersBundle).toContain("staticHandler");
  });

  test("build-time handler content not in client bundle", () => {
    expect(clientBundle).not.toContain("statically rendered at build time");
    expect(clientBundle).not.toContain("Table of Contents");
  });

  test("build-time handler content not in SSR bundle", () => {
    expect(ssrBundle).not.toContain("statically rendered at build time");
    expect(ssrBundle).not.toContain("Table of Contents");
  });

  test("node:fs should NOT be in client bundle", () => {
    expect(clientBundle).not.toContain("readFileSync");
    expect(clientBundle).not.toContain("readDocsNavItems");
  });

  test("node:fs should NOT be in SSR bundle", () => {
    expect(ssrBundle).not.toContain("readFileSync");
    expect(ssrBundle).not.toContain("readDocsNavItems");
  });

  test("readDocsNavItems helper remains in static-handlers RSC chunk after eviction", () => {
    // After handler eviction, readDocsNavItems stays in the chunk because
    // eviction is a post-build string replacement -- Rollup already bundled
    // the helper. node:fs is imported dynamically, not at module scope.
    expect(staticHandlersBundle).toContain("readDocsNavItems");
    expect(staticHandlersBundle).not.toMatch(
      /import\s*\{[^}]*readFileSync[^}]*\}\s*from\s*["']node:fs["']/,
    );
  });
});

// -- Helpers --

function readAllFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
}
