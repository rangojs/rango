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

test.describe("prerender passthrough (production)", () => {
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
    await expect(testId(page, "guide-build")).toHaveText("Build: true");
    await expect(testId(page, "guide-slug")).toHaveText("Slug: routing");
    await expect(testId(page, "guide-rendered-at")).toBeVisible();
  });

  test("second pre-rendered slug renders on direct visit", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/guides/caching"));
    await waitForHydration(page);

    await expect(testId(page, "guide-detail")).toBeVisible();
    await expect(testId(page, "guide-title")).toHaveText("Caching Guide");
    await expect(testId(page, "guide-build")).toHaveText("Build: true");
    await expect(testId(page, "guide-slug")).toHaveText("Slug: caching");
  });

  test("unknown slug renders live via passthrough handler", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/guides/unknown-slug"));
    await waitForHydration(page);

    await expect(testId(page, "guide-detail")).toBeVisible();
    await expect(testId(page, "guide-title")).toHaveText("Guide: unknown-slug");
    await expect(testId(page, "guide-build")).toHaveText("Build: false");
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
    await expect(testId(page, "guide-build")).toHaveText("Build: false");
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
    await expect(testId(page, "guide-title")).toHaveText("Guide: dynamic-test");
    await expect(testId(page, "guide-build")).toHaveText("Build: false");
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

    await page.goto(f.url("/articles/page/1"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    // articles (prerendered, passthrough) -> guides (prerendered, passthrough)
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

test.describe("prerender passthrough bundle output (production)", () => {
  let prerenderHandlersBundle: string;
  let clientBundle: string;
  let ssrBundle: string;

  test.beforeAll(() => {
    // After manualChunks removal (#436), prerender handler stubs are inlined
    // into the RSC entry/worker-entry chunk instead of a separate
    // __prerender-handlers file. Under Rolldown (Vite 8) that entry is
    // dist/rsc/index.js (Rollup placed it in an assets/ chunk), so include the
    // entry too. Exclude __pr-*/__st-* prerender asset files (rendered output,
    // not handler code).
    const rscEntry = path.join(DIST, "rsc/index.js");
    prerenderHandlersBundle =
      (fs.existsSync(rscEntry)
        ? fs.readFileSync(rscEntry, "utf-8") + "\n"
        : "") +
      readAllFiles(path.join(DIST, "rsc/assets"))
        .filter((f) => !f.startsWith("__pr-") && !f.startsWith("__st-"))
        .map((f) => fs.readFileSync(path.join(DIST, "rsc/assets", f), "utf-8"))
        .join("\n");
    clientBundle = concatBundleContents(path.join(DIST, "client/assets"));
    ssrBundle = concatBundleContents(path.join(DIST, "rsc/ssr/assets"));
  });

  test("prerender definitions are evicted from RSC bundle", () => {
    // GuidesDetailDef (Prerender def) should be replaced with a stub
    expect(prerenderHandlersBundle).toMatch(
      /const\s+GuidesDetailDef\s*=\s*\{\s*__brand:\s*"prerenderHandler"/,
    );
  });

  test("PaginatedArticlesDef is evicted from RSC bundle", () => {
    // PaginatedArticlesDef (Prerender def) should be replaced with a stub
    expect(prerenderHandlersBundle).toMatch(
      /const\s+PaginatedArticlesDef\s*=\s*\{\s*__brand:\s*"prerenderHandler"/,
    );
  });

  test("non-passthrough handlers ARE evicted from RSC bundle", () => {
    // ArticleDetail (no passthrough) should be replaced with a stub
    expect(prerenderHandlersBundle).toMatch(
      /const\s+ArticleDetail\s*=\s*\{\s*__brand:\s*"prerenderHandler"/,
    );
  });

  test("passthrough handler not in client bundle", () => {
    expect(clientBundle).not.toContain("GuidesDetailDef");
  });

  test("passthrough handler not in SSR bundle", () => {
    expect(ssrBundle).not.toContain("GuidesDetailDef");
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

test.describe("prerender passthrough assets (production)", () => {
  const RSC_DIR = path.join(DIST, "rsc");
  const RSC_ASSETS_DIR = path.join(RSC_DIR, "assets");

  test("guides.detail routes exist in prerender manifest", () => {
    const manifestCode = fs.readFileSync(
      path.join(RSC_DIR, "__prerender-manifest.js"),
      "utf-8",
    );
    const jsonMatch = manifestCode.match(/JSON\.parse\('(.+)'\)/);
    expect(jsonMatch).toBeTruthy();
    const manifest: Record<string, string> = JSON.parse(jsonMatch![1]);
    // 2 known slugs: routing, caching — each has a param hash key
    const guidesKeys = Object.keys(manifest).filter((k) =>
      k.startsWith("guides.detail/"),
    );
    expect(guidesKeys).toHaveLength(2);
  });

  test("prerender asset files for guides have valid segments and handles", () => {
    const manifestCode = fs.readFileSync(
      path.join(RSC_DIR, "__prerender-manifest.js"),
      "utf-8",
    );
    const jsonMatch = manifestCode.match(/JSON\.parse\('(.+)'\)/);
    expect(jsonMatch).toBeTruthy();
    const manifest: Record<string, string> = JSON.parse(jsonMatch![1]);

    // Get asset specifiers for guides.detail entries
    const guidesSpecifiers = Object.entries(manifest)
      .filter(([k]) => k.startsWith("guides.detail/"))
      .map(([, v]) => v);
    expect(guidesSpecifiers).toHaveLength(2);

    for (const specifier of guidesSpecifiers) {
      // Specifiers are like "./assets/__pr-abcd1234.js"
      const fileName = specifier.replace("./assets/", "");
      const content = fs.readFileSync(
        path.join(RSC_ASSETS_DIR, fileName),
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
    await expect(testId(page, "guide-build")).toHaveText("Build: true");
    await expect(testId(page, "guide-slug")).toHaveText("Slug: routing");
    await expect(testId(page, "guide-rendered-at")).toBeVisible();
  });

  test("second known slug renders live in dev mode", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/guides/caching"));
    await waitForHydration(page);

    await expect(testId(page, "guide-detail")).toBeVisible();
    await expect(testId(page, "guide-title")).toHaveText("Caching Guide");
    await expect(testId(page, "guide-build")).toHaveText("Build: true");
  });

  test("unknown slug renders live in dev mode", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/guides/unknown-slug"));
    await waitForHydration(page);

    await expect(testId(page, "guide-detail")).toBeVisible();
    await expect(testId(page, "guide-title")).toHaveText("Guide: unknown-slug");
    await expect(testId(page, "guide-build")).toHaveText("Build: false");
    await expect(testId(page, "guide-slug")).toHaveText("Slug: unknown-slug");
  });

  test("client navigation to unknown slug in dev mode", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/guides/routing"));
    await waitForHydration(page);

    await using __ = await expectNoReload(page);

    await testId(page, "guide-link-dynamic").click();
    await expect(testId(page, "guide-title")).toHaveText("Guide: dynamic-test");
    await expect(testId(page, "guide-build")).toHaveText("Build: false");
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
