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

const DIST = path.resolve("dist");

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

test.describe.configure({ mode: "serial" });

// =============================================================================
// Build mode: runtime behavior tests
// =============================================================================

test.describe("prerender passthrough (build)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  // -- Direct visit tests --

  test("pre-rendered slug renders on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/guides/routing"));
    await waitForHydration(page);

    await expect(testId(page, "guide-detail")).toBeVisible();
    await expect(testId(page, "guide-title")).toHaveText("Routing Guide");
    await expect(testId(page, "guide-slug")).toHaveText("Slug: routing");
    await expect(testId(page, "guide-rendered-at")).toBeVisible();
  });

  test("second pre-rendered slug renders on direct visit", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/guides/caching"));
    await waitForHydration(page);

    await expect(testId(page, "guide-detail")).toBeVisible();
    await expect(testId(page, "guide-title")).toHaveText("Caching Guide");
    await expect(testId(page, "guide-slug")).toHaveText("Slug: caching");
  });

  test("unknown slug renders live via passthrough handler", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/guides/unknown-slug"));
    await waitForHydration(page);

    await expect(testId(page, "guide-detail")).toBeVisible();
    await expect(testId(page, "guide-title")).toHaveText(
      "Guide: unknown-slug",
    );
    await expect(testId(page, "guide-slug")).toHaveText("Slug: unknown-slug");
    await expect(testId(page, "guide-rendered-at")).toBeVisible();
  });

  test("another unknown slug also renders live", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/guides/any-arbitrary-slug"));
    await waitForHydration(page);

    await expect(testId(page, "guide-detail")).toBeVisible();
    await expect(testId(page, "guide-title")).toHaveText(
      "Guide: any-arbitrary-slug",
    );
  });

  // -- Client-side navigation tests --

  test("client navigation from non-prerendered to pre-rendered slug", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/counter"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    await testId(page, "nav-guides").click();
    await expect(testId(page, "guide-detail")).toBeVisible();
    await expect(testId(page, "guide-title")).toHaveText("Routing Guide");
  });

  test("both pre-rendered slugs accessible via direct visit", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Verify first pre-rendered slug
    await page.goto(f.url("/guides/routing"));
    await waitForHydration(page);
    await expect(testId(page, "guide-title")).toHaveText("Routing Guide");

    // Verify second pre-rendered slug
    await page.goto(f.url("/guides/caching"));
    await waitForHydration(page);
    await expect(testId(page, "guide-title")).toHaveText("Caching Guide");
    await expect(testId(page, "guide-slug")).toHaveText("Slug: caching");
  });

  test("client navigation from pre-rendered to unknown slug (live fallback)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/guides/routing"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    // Navigate from pre-rendered routing -> unknown dynamic-test (live render)
    await testId(page, "guide-link-dynamic").click();
    await expect(testId(page, "guide-detail")).toBeVisible();
    await expect(testId(page, "guide-title")).toHaveText(
      "Guide: dynamic-test",
    );
    await expect(testId(page, "guide-slug")).toHaveText("Slug: dynamic-test");
  });

  test("client navigation from unknown slug back to non-guide route", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/guides/dynamic-test"));
    await waitForHydration(page);
    await expect(testId(page, "guide-title")).toHaveText("Guide: dynamic-test");

    await using __ = await expectNoReload(page);

    // Navigate from unknown guide -> counter (non-prerendered)
    await testId(page, "nav-counter").click();
    await expect(testId(page, "counter-page")).toBeVisible();
  });

  // -- Cross-route navigation tests --

  test("non-prerendered to passthrough to non-prerendered", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/counter"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    // counter -> guides (passthrough pre-rendered)
    await testId(page, "nav-guides").click();
    await expect(testId(page, "guide-detail")).toBeVisible();

    // guides -> about (non-prerendered)
    await testId(page, "nav-about").click();
    await expect(testId(page, "about-page")).toBeVisible();
  });

  test("prerendered articles to passthrough guides", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/articles"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    // articles (prerendered, no passthrough) -> guides (prerendered, passthrough)
    await testId(page, "nav-guides").click();
    await expect(testId(page, "guide-detail")).toBeVisible();
    await expect(testId(page, "guide-title")).toHaveText("Routing Guide");
  });

  // -- Back/forward navigation --

  test("back/forward navigation between passthrough and non-passthrough routes", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/counter"));
    await waitForHydration(page);

    // Navigate to guides (pre-rendered passthrough)
    await testId(page, "nav-guides").click();
    await expect(testId(page, "guide-detail")).toBeVisible();
    await expect(testId(page, "guide-title")).toHaveText("Routing Guide");

    // Navigate to about (non-prerendered)
    await testId(page, "nav-about").click();
    await expect(testId(page, "about-page")).toBeVisible();

    // Browser back -> guides
    await page.goBack();
    await expect(testId(page, "guide-detail")).toBeVisible();

    // Browser back -> counter
    await page.goBack();
    await expect(testId(page, "counter-page")).toBeVisible();

    // Browser forward -> guides
    await page.goForward();
    await expect(testId(page, "guide-detail")).toBeVisible();

    // Browser forward -> about
    await page.goForward();
    await expect(testId(page, "about-page")).toBeVisible();
  });

  // -- Nav bar visibility --

  test("nav bar renders on passthrough route", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/guides/routing"));
    await waitForHydration(page);

    await expect(testId(page, "nav")).toBeVisible();
    await expect(testId(page, "nav-guides")).toBeVisible();
  });

  test("nav bar renders on live-rendered unknown slug", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/guides/unknown-slug"));
    await waitForHydration(page);

    await expect(testId(page, "nav")).toBeVisible();
  });
});

// =============================================================================
// Build mode: bundle output validation tests
// =============================================================================

test.describe("prerender passthrough bundle output", () => {
  let prerenderHandlersBundle: string;
  let clientBundle: string;
  let ssrBundle: string;

  test.beforeAll(() => {
    const rscAssets = readAllFiles(path.join(DIST, "rsc/assets"));
    const handlerFile = rscAssets.find((f) =>
      f.startsWith("__prerender-handlers"),
    );
    expect(handlerFile).toBeTruthy();
    prerenderHandlersBundle = fs.readFileSync(
      path.join(DIST, "rsc/assets", handlerFile!),
      "utf-8",
    );
    clientBundle = concatBundleContents(path.join(DIST, "client/assets"));
    ssrBundle = concatBundleContents(path.join(DIST, "rsc/ssr/assets"));
  });

  test("passthrough handler code stays in RSC prerender-handlers chunk", () => {
    // GuidesDetail (passthrough: true) should NOT be replaced with a stub
    // It should contain the full createPrerenderHandler call
    expect(prerenderHandlersBundle).toContain("GuidesDetail");
    expect(prerenderHandlersBundle).toMatch(
      /const\s+GuidesDetail\s*=\s*createPrerenderHandler/,
    );
  });

  test("non-passthrough handlers ARE evicted from RSC bundle", () => {
    // ArticlesIndex (no passthrough) should be replaced with a stub
    expect(prerenderHandlersBundle).toMatch(
      /const\s+ArticlesIndex\s*=\s*\{\s*__brand:\s*"prerenderHandler"/,
    );
    // ArticleDetail (no passthrough) should also be replaced with a stub
    expect(prerenderHandlersBundle).toMatch(
      /const\s+ArticleDetail\s*=\s*\{\s*__brand:\s*"prerenderHandler"/,
    );
  });

  test("passthrough handler not in client bundle", () => {
    expect(clientBundle).not.toContain("GuidesDetail");
  });

  test("passthrough handler not in SSR bundle", () => {
    expect(ssrBundle).not.toContain("GuidesDetail");
  });

  test("passthrough handler-specific code stays in RSC bundle", () => {
    // The guide title lookup logic should be in the bundle
    expect(prerenderHandlersBundle).toContain("Routing Guide");
    expect(prerenderHandlersBundle).toContain("Caching Guide");
  });

  test("passthrough handler-specific code not in client bundle", () => {
    expect(clientBundle).not.toContain("Routing Guide");
    expect(clientBundle).not.toContain("Caching Guide");
  });

  test("passthrough handler-specific code not in SSR bundle", () => {
    expect(ssrBundle).not.toContain("Routing Guide");
    expect(ssrBundle).not.toContain("Caching Guide");
  });
});

// =============================================================================
// Build mode: prerender asset structure tests
// =============================================================================

test.describe("prerender passthrough assets", () => {
  const RSC_DIR = path.join(DIST, "rsc");
  const RSC_ASSETS_DIR = path.join(RSC_DIR, "assets");

  test("guides.detail routes exist in prerender manifest", () => {
    const manifestCode = fs.readFileSync(
      path.join(RSC_DIR, "__prerender-manifest.js"),
      "utf-8",
    );
    // 2 known slugs: routing, caching — each has a param hash key
    expect(manifestCode).toMatch(/"guides\.detail\/[a-f0-9]+"/);
    // Count the number of guides.detail entries
    const matches = manifestCode.match(/"guides\.detail\/[a-f0-9]+"/g);
    expect(matches).toHaveLength(2);
  });

  test("prerender asset files for guides have valid segments and handles", () => {
    const manifestCode = fs.readFileSync(
      path.join(RSC_DIR, "__prerender-manifest.js"),
      "utf-8",
    );
    // Extract __pr-*.js filenames referenced by guides.detail entries
    const guidesImports = manifestCode.match(
      /"guides\.detail\/[a-f0-9]+":\(\)=>import\("\.\/assets\/(__pr-[a-f0-9]+\.js)"\)/g,
    );
    expect(guidesImports).toHaveLength(2);

    for (const imp of guidesImports!) {
      const fileMatch = imp.match(/__pr-[a-f0-9]+\.js/);
      expect(fileMatch).toBeTruthy();
      const content = fs.readFileSync(
        path.join(RSC_ASSETS_DIR, fileMatch![0]),
        "utf-8",
      );
      const dataMatch = content.match(/export default\s+({[\s\S]*});\s*$/);
      expect(dataMatch).toBeTruthy();
      const data = JSON.parse(dataMatch![1]);
      expect(data).toHaveProperty("segments");
      expect(data).toHaveProperty("handles");
      expect(Array.isArray(data.segments)).toBe(true);
      expect(data.segments.length).toBeGreaterThan(0);
    }
  });

});

// =============================================================================
// Dev mode tests
// =============================================================================

test.describe("prerender passthrough (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("known slug renders live in dev mode", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/guides/routing"));
    await waitForHydration(page);

    await expect(testId(page, "guide-detail")).toBeVisible();
    await expect(testId(page, "guide-title")).toHaveText("Routing Guide");
    await expect(testId(page, "guide-slug")).toHaveText("Slug: routing");
    await expect(testId(page, "guide-rendered-at")).toBeVisible();
  });

  test("second known slug renders live in dev mode", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/guides/caching"));
    await waitForHydration(page);

    await expect(testId(page, "guide-detail")).toBeVisible();
    await expect(testId(page, "guide-title")).toHaveText("Caching Guide");
  });

  test("unknown slug renders live in dev mode", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/guides/unknown-slug"));
    await waitForHydration(page);

    await expect(testId(page, "guide-detail")).toBeVisible();
    await expect(testId(page, "guide-title")).toHaveText("Guide: unknown-slug");
    await expect(testId(page, "guide-slug")).toHaveText("Slug: unknown-slug");
  });

  test("client navigation to unknown slug in dev mode", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/guides/routing"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    await testId(page, "guide-link-dynamic").click();
    await expect(testId(page, "guide-title")).toHaveText(
      "Guide: dynamic-test",
    );
  });

  test("client navigation between guides in dev mode", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/guides/routing"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    await testId(page, "guide-link-caching").click();
    await expect(testId(page, "guide-title")).toHaveText("Caching Guide");

    await testId(page, "guide-link-routing").click();
    await expect(testId(page, "guide-title")).toHaveText("Routing Guide");
  });

  test("cross-route navigation in dev mode", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/counter"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    await testId(page, "nav-guides").click();
    await expect(testId(page, "guide-detail")).toBeVisible();

    await testId(page, "nav-about").click();
    await expect(testId(page, "about-page")).toBeVisible();
  });
});
