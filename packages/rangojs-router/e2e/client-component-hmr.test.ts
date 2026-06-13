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
    "./e2e/test-app/src/components/NavigationStatus.tsx",
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

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Verify the component renders with original text
    await expect(testId(page, "nav-status-state")).toHaveText(/state:/);

    // Inject reload detection
    await using __ = await expectNoReload(page);

    // Make a visible change to the client component
    const modified = originalContent.replace(
      "state:{nav.state}",
      "state(HMR):{nav.state}",
    );
    fs.writeFileSync(componentPath, modified);

    // The change should appear via HMR without reload
    await expect(testId(page, "nav-status-state")).toHaveText(/state\(HMR\):/, {
      timeout: 15000,
    });

    // expectNoReload will assert via Symbol.asyncDispose that no reload happened
  });

  test("should not trigger excessive HMR updates for a single file change", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await expect(testId(page, "nav-status-state")).toHaveText(/state:/);

    await using __ = await expectNoReload(page);

    const hmr = await captureHmrEvents(page);

    // Touch the file with a trivial change (add a comment)
    const modified = originalContent + `\n// HMR test trigger: ${Date.now()}\n`;
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

/**
 * Regression guard for vite-plugin-react#1248 ("keep client HMR for client
 * modules co-located with rsc-graph code").
 *
 * ColocatedFrShared.tsx has no "use client" directive but lives in both module
 * graphs: the rsc graph (the server route imports ColocatedFrServerNote) and
 * the client graph (the "use client" island imports ColocatedFrMarker). This
 * is the precondition for plugin-rsc's client-branch hotUpdate guard, which
 * returns [] (dropping client Fast Refresh) for an rsc-graph file that is NOT
 * inside a client boundary.
 *
 * For Rango this guard never fires: the shared file's only client-graph
 * importer is the island, a "use client" client reference, so
 * isInsideClientBoundary short-circuits the guard and Fast Refresh is kept.
 * This test pins that, editing the marker text and asserting the island's
 * seeded state survives (a Fast Refresh, not a remount or full reload). It is
 * dev-only because HMR has no production form; render/hydration of the same
 * route in dev AND production is covered by colocated-fast-refresh.test.ts.
 */
test.describe.serial("colocated-fast-refresh-hmr", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.setTimeout(30000);

  const sharedPath = path.resolve(
    "./e2e/test-app/src/components/ColocatedFrShared.tsx",
  );
  let sharedOriginal: string;

  test.beforeAll(async () => {
    sharedOriginal = fs.readFileSync(sharedPath, "utf-8");
  });

  test.afterEach(async () => {
    fs.writeFileSync(sharedPath, sharedOriginal);
    // Wait for HMR to process the restore
    await new Promise((r) => setTimeout(r, 1000));
  });

  test("editing a non-'use client' file imported by a 'use client' island keeps Fast Refresh", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/colocated-fr"));
    await waitForHydration(page);

    await expect(testId(page, "colocated-fr-marker")).toHaveText(
      "marker-baseline",
    );

    // Seed island state to prove the edit is a Fast Refresh, not a remount.
    await testId(page, "colocated-fr-count").click();
    await testId(page, "colocated-fr-count").click();
    await expect(testId(page, "colocated-fr-count")).toHaveText("count: 2");

    // Inject reload detection
    await using __ = await expectNoReload(page);

    // Edit the marker text in the non-"use client" shared file.
    const modified = sharedOriginal.replace("marker-baseline", "marker-edited");
    fs.writeFileSync(sharedPath, modified);

    // The change appears via HMR...
    await expect(testId(page, "colocated-fr-marker")).toHaveText(
      "marker-edited",
      { timeout: 15000 },
    );
    // ...and the seeded island state survives, proving Fast Refresh rather than
    // a dropped update / remount / full reload.
    await expect(testId(page, "colocated-fr-count")).toHaveText("count: 2");

    // expectNoReload asserts via Symbol.asyncDispose that no reload happened
  });
});
