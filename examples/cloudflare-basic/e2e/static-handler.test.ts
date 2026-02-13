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
// Dev mode: createStaticHandler behaves as a normal handler (runs live)
// Tests all three DSL positions: layout(), path(), parallel()
// ==========================================================================

test.describe("static-handler (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  // -- layout() with createStaticHandler --

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

  // -- path() with createStaticHandler --

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

  // -- parallel() with createStaticHandler --

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
    await expect(testId(page, "docs-page-title")).toHaveText(
      "Doc: deployment",
    );

    // Layout and parallel slot still visible
    await expect(testId(page, "static-docs-layout")).toBeVisible();
    await expect(testId(page, "static-toc-sidebar")).toBeVisible();
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

  // -- layout() with createStaticHandler --

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

  // -- path() with createStaticHandler --

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

  // -- parallel() with createStaticHandler --

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
    await expect(testId(page, "docs-page-title")).toHaveText(
      "Doc: deployment",
    );

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
      .map((f) =>
        fs.readFileSync(path.join(DIST, "client/assets", f), "utf-8"),
      )
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

  test("static handler code is present in RSC bundle (not yet evicted)", () => {
    // Handler code lives in the RSC bundle until build-time rendering
    // + asset serialization is implemented. Once that's done, handler
    // bodies will be evicted and replaced with asset-loading stubs.
    expect(staticHandlersBundle).toContain("createStaticHandler");
    expect(staticHandlersBundle).toContain("Docs Navigation");
    expect(staticHandlersBundle).toContain("Table of Contents");
  });

  test("build-time handler content not in client bundle", () => {
    expect(clientBundle).not.toContain(
      "statically rendered at build time",
    );
    expect(clientBundle).not.toContain("Table of Contents");
  });

  test("build-time handler content not in SSR bundle", () => {
    expect(ssrBundle).not.toContain(
      "statically rendered at build time",
    );
    expect(ssrBundle).not.toContain("Table of Contents");
  });
});

// -- Helpers --

function readAllFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
}
