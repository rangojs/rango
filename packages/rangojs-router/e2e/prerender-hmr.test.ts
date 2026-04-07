import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";
import fs from "node:fs";
import path from "node:path";

/**
 * HMR tests for pre-rendered and static content.
 *
 * Verifies that editing a Prerender() or Static() handler — and
 * components they import — applies the change via HMR in dev mode.
 *
 * LOCAL ONLY — skipped on CI because file-watcher flakiness on
 * virtualized FS makes HMR timing unreliable.
 */
test.skip(!!process.env.CI, "local-only HMR test — skipped on CI");

test.describe.serial("prerender-hmr", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.setTimeout(30_000);

  // -- Prerender() handler file test (contains urls()) --------------------

  const prerenderPath = path.resolve("./e2e/test-app/src/urls/prerender.tsx");
  let prerenderOriginal: string;

  test.beforeAll(async () => {
    prerenderOriginal = fs.readFileSync(prerenderPath, "utf-8");
  });

  test.afterAll(async () => {
    fs.writeFileSync(prerenderPath, prerenderOriginal);
    await new Promise((r) => setTimeout(r, 1000));
  });

  test("editing Prerender() handler content updates via HMR", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/docs"));
    await waitForHydration(page);

    await expect(testId(page, "docs-content")).toHaveText(
      "This is pre-rendered documentation content.",
    );

    const modified = prerenderOriginal.replace(
      "This is pre-rendered documentation content.",
      "HMR updated pre-rendered content.",
    );
    fs.writeFileSync(prerenderPath, modified);

    await expect(testId(page, "docs-content")).toHaveText(
      "HMR updated pre-rendered content.",
      { timeout: 15000 },
    );
  });

  test("editing Static() handler content updates via HMR", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-page"));
    await waitForHydration(page);

    await expect(testId(page, "static-page-content")).toHaveText(
      "This is a statically pre-rendered page.",
    );

    const modified = prerenderOriginal.replace(
      "This is a statically pre-rendered page.",
      "HMR updated static content.",
    );
    fs.writeFileSync(prerenderPath, modified);

    await expect(testId(page, "static-page-content")).toHaveText(
      "HMR updated static content.",
      { timeout: 15000 },
    );
  });

  // -- Imported component file test (no urls()) --------------------------
  // This is the key regression test: editing a component imported by a
  // Prerender route must also trigger a visible HMR update. Before the fix,
  // the dev prerender store served stale content because the RouterRegistry
  // snapshot wasn't refreshed for non-route file changes.

  const layoutPath = path.resolve(
    "./e2e/test-app/src/components/layouts/PrerenderComplexLayout.tsx",
  );
  let layoutOriginal: string;

  test.beforeAll(async () => {
    layoutOriginal = fs.readFileSync(layoutPath, "utf-8");
  });

  test.afterAll(async () => {
    fs.writeFileSync(layoutPath, layoutOriginal);
    await new Promise((r) => setTimeout(r, 1000));
  });

  test("editing imported layout component updates via HMR", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-complex"));
    await waitForHydration(page);

    // Layout renders (wraps the prerender content)
    await expect(testId(page, "prerender-complex-layout")).toBeVisible();

    // Add visible marker to the layout
    const modified = layoutOriginal.replace(
      "<Outlet />",
      '<p data-testid="hmr-layout-marker">HMR layout update</p><Outlet />',
    );
    fs.writeFileSync(layoutPath, modified);

    // The new marker should appear via HMR
    await expect(testId(page, "hmr-layout-marker")).toHaveText(
      "HMR layout update",
      { timeout: 15000 },
    );
  });
});
