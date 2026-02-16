import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  testId,
  expectNoReload,
  captureHmrEvents,
} from "./helper";
import fs from "node:fs";
import path from "node:path";

/**
 * Tests for client component HMR:
 * 1. Editing a "use client" component should NOT cause a full page reload
 * 2. HMR should apply cleanly without multiple redundant update cycles
 *
 * Requires @vitejs/plugin-react for React Refresh (per-file HMR boundaries)
 * and the @rangojs/router:client-component-hmr plugin to prevent the RSC/SSR
 * environments from triggering full-reload when "use client" modules change.
 */

test.describe.serial("client-component-hmr", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.setTimeout(30000);

  const componentPath = path.resolve(
    "./e2e/test-app/src/components/ClientLoaderContent.tsx",
  );
  let originalContent: string;

  test.beforeAll(async () => {
    originalContent = fs.readFileSync(componentPath, "utf-8");
  });

  test.afterEach(async () => {
    fs.writeFileSync(componentPath, originalContent);
    // Wait for HMR to process the restore
    await new Promise((r) => setTimeout(r, 1000));
  });

  test("should update client component via HMR without full reload", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/client-loader"));
    await waitForHydration(page);

    // Wait for the client loader to resolve (it loads async after hydration)
    await expect(testId(page, "client-loader-content")).toBeVisible({
      timeout: 10000,
    });
    await expect(testId(page, "client-loader-title")).toHaveText(
      "Client Loader Test",
    );

    // Inject reload detection
    await using __ = await expectNoReload(page);

    // Make a visible change to the client component
    const modified = originalContent.replace(
      "Theme: {data.theme}",
      "Theme (HMR): {data.theme}",
    );
    fs.writeFileSync(componentPath, modified);

    // The change should appear via HMR without reload
    await expect(testId(page, "client-loader-theme")).toHaveText(
      /Theme \(HMR\):/,
      { timeout: 15000 },
    );

    // expectNoReload will assert via Symbol.asyncDispose that no reload happened
  });

  test("should not trigger excessive HMR updates for a single file change", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/client-loader"));
    await waitForHydration(page);

    await expect(testId(page, "client-loader-content")).toBeVisible({
      timeout: 10000,
    });

    await using __ = await expectNoReload(page);

    const hmr = await captureHmrEvents(page);

    // Touch the file with a trivial change (add a comment)
    const modified =
      originalContent + `\n// HMR test trigger: ${Date.now()}\n`;
    fs.writeFileSync(componentPath, modified);

    // Wait for HMR to complete
    await page.waitForTimeout(5000);

    hmr.dispose();

    // A single client component change should NOT trigger a full reload
    expect(
      hmr.fullReloads.length,
      "Client component change should not trigger a full reload",
    ).toBe(0);

    // Should produce at most 2 HMR updates (not cascading writes)
    expect(hmr.updates.length).toBeLessThanOrEqual(2);
  });
});
