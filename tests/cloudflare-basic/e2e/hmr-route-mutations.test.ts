import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, testId } from "./helper";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

// Route mutation tests are too flaky on GH Actions due to unreliable inotify
// on overlayfs. Run locally only; skip in CI.
test.describe.serial("hmr-route-mutations", () => {
  test.skip(
    !!process.env.CI,
    "Skipped in CI — inotify unreliable on GH Actions",
  );
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test.setTimeout(90000);

  // Generous timeout for route tree mutations - the program reload
  // cycle (file change -> gen file -> virtual module -> program reload)
  // can take 10-20s depending on system load.
  const ROUTE_CHANGE_TIMEOUT = 30000;

  // Restore git-tracked sources in case a prior timed-out test left
  // modified files on disk (afterEach does not run when workers crash).
  test.beforeAll(() => {
    try {
      execSync("git checkout -- src/urls.tsx", {
        cwd: f.root,
        stdio: "ignore",
      });
    } catch {}
  });

  const originalContents = new Map<string, string>();

  function urlsPath() {
    return path.join(f.root, "src/urls.tsx");
  }

  function readUrls() {
    return fs.readFileSync(urlsPath(), "utf-8");
  }

  function saveAndWrite(filePath: string, content: string) {
    if (!originalContents.has(filePath)) {
      originalContents.set(filePath, fs.readFileSync(filePath, "utf-8"));
    }
    fs.writeFileSync(filePath, content, "utf-8");
  }

  // Write a file and periodically re-touch it to ensure the watcher picks
  // up the change even when a prior HMR cycle is still settling. Returns a
  // cleanup function to stop the periodic re-touch.
  function writeWithRetouch(
    filePath: string,
    content: string,
    intervalMs = 8000,
  ) {
    saveAndWrite(filePath, content);
    const timer = setInterval(() => {
      fs.writeFileSync(filePath, content, "utf-8");
    }, intervalMs);
    return () => clearInterval(timer);
  }

  test.afterEach(async () => {
    for (const [filePath, content] of originalContents) {
      fs.writeFileSync(filePath, content, "utf-8");
    }
    originalContents.clear();
    // Wait for program reload to process restores
    await new Promise((r) => setTimeout(r, 5000));
  });

  // -- Group 1: Basic Add/Remove/Rename --

  test("should serve a newly added route", async ({ page }) => {
    const content = readUrls();
    const modified = content.replace(
      'path("/about", AboutPage, { name: "about" }),',
      `path("/about", AboutPage, { name: "about" }),
        path("/hmr-test-route", () => <div data-testid="hmr-new-route">HMR New Route</div>, { name: "hmrTest" }),`,
    );
    expect(modified).not.toBe(content);
    const stopRetouch = writeWithRetouch(urlsPath(), modified);

    await expect(async () => {
      await page.goto(f.url("/hmr-test-route"));
      await expect(testId(page, "hmr-new-route")).toBeVisible({
        timeout: 2000,
      });
    }).toPass({ timeout: ROUTE_CHANGE_TIMEOUT });
    stopRetouch();

    await expect(testId(page, "hmr-new-route")).toHaveText("HMR New Route");
  });

  test("should fall through to catch-all for a removed route", async ({
    page,
  }) => {
    // Verify route works initially
    await page.goto(f.url("/about"));
    await waitForHydration(page);
    await expect(testId(page, "about-page")).toBeVisible();

    const content = readUrls();
    const modified = content.replace(
      'path("/about", AboutPage, { name: "about" }),',
      '// path("/about", AboutPage, { name: "about" }),',
    );
    expect(modified).not.toBe(content);
    const stopRetouch = writeWithRetouch(urlsPath(), modified);

    await expect(async () => {
      await page.goto(f.url("/about"));
      await expect(testId(page, "catch-all-page")).toBeVisible({
        timeout: 2000,
      });
    }).toPass({ timeout: ROUTE_CHANGE_TIMEOUT });
    stopRetouch();
  });

  test("should serve a route at its new path after path rename", async ({
    page,
  }) => {
    const content = readUrls();
    const modified = content.replace(
      'path("/about", AboutPage, { name: "about" }),',
      'path("/about-us", AboutPage, { name: "aboutUs" }),',
    );
    expect(modified).not.toBe(content);
    const stopRetouch = writeWithRetouch(urlsPath(), modified);

    // New path should work
    await expect(async () => {
      await page.goto(f.url("/about-us"));
      await expect(testId(page, "about-page")).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: ROUTE_CHANGE_TIMEOUT });
    stopRetouch();

    // Old path should hit catch-all
    await page.goto(f.url("/about"));
    await expect(testId(page, "catch-all-page")).toBeVisible();
  });

  test("should serve route at new path when only URL changes (name preserved)", async ({
    page,
  }) => {
    const content = readUrls();
    const modified = content.replace(
      'path("/counter", CounterPage, { name: "counter" }),',
      'path("/counter-v2", CounterPage, { name: "counter" }),',
    );
    expect(modified).not.toBe(content);
    const stopRetouch = writeWithRetouch(urlsPath(), modified);

    await expect(async () => {
      await page.goto(f.url("/counter-v2"));
      await expect(testId(page, "counter-page")).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: ROUTE_CHANGE_TIMEOUT });
    stopRetouch();

    await page.goto(f.url("/counter"));
    await expect(testId(page, "catch-all-page")).toBeVisible();
  });

  // -- Group 2: Sequential & Burst Edits --

  test("should handle sequential add, rename, remove", async ({ page }) => {
    const p = urlsPath();

    // Step 1: Add route
    const original = readUrls();
    const withRoute = original.replace(
      'path("/about", AboutPage, { name: "about" }),',
      `path("/about", AboutPage, { name: "about" }),
        path("/hmr-sequential", () => <div data-testid="hmr-sequential">Sequential</div>, { name: "hmrSequential" }),`,
    );
    let stopRetouch = writeWithRetouch(p, withRoute);

    await expect(async () => {
      await page.goto(f.url("/hmr-sequential"));
      await expect(testId(page, "hmr-sequential")).toBeVisible({
        timeout: 2000,
      });
    }).toPass({ timeout: ROUTE_CHANGE_TIMEOUT });
    stopRetouch();

    // Step 2: Rename path
    const renamed = readUrls().replace("/hmr-sequential", "/hmr-sequential-v2");
    stopRetouch = writeWithRetouch(p, renamed);

    await expect(async () => {
      await page.goto(f.url("/hmr-sequential-v2"));
      await expect(testId(page, "hmr-sequential")).toBeVisible({
        timeout: 2000,
      });
    }).toPass({ timeout: ROUTE_CHANGE_TIMEOUT });
    stopRetouch();

    await page.goto(f.url("/hmr-sequential"));
    await expect(testId(page, "catch-all-page")).toBeVisible();

    // Step 3: Remove route
    const removed = readUrls().replace(
      /\s*path\("\/hmr-sequential-v2".*\{[^}]*name:\s*"hmrSequential"[^}]*\}\s*\),/,
      "",
    );
    stopRetouch = writeWithRetouch(p, removed);

    await expect(async () => {
      await page.goto(f.url("/hmr-sequential-v2"));
      await expect(testId(page, "catch-all-page")).toBeVisible({
        timeout: 2000,
      });
    }).toPass({ timeout: ROUTE_CHANGE_TIMEOUT });
    stopRetouch();
  });

  test("should handle burst rapid edits and serve final state", async ({
    page,
  }) => {
    const p = urlsPath();
    const original = readUrls();

    // 3 rapid writes with no delay
    const v1 = original.replace(
      'path("/about", AboutPage, { name: "about" }),',
      `path("/about", AboutPage, { name: "about" }),
        path("/hmr-burst", () => <div data-testid="hmr-burst">Burst V1</div>, { name: "hmrBurst" }),`,
    );
    saveAndWrite(p, v1);

    const v2 = v1.replace("Burst V1", "Burst V2");
    fs.writeFileSync(p, v2, "utf-8");

    const v3 = v2.replace("Burst V2", "Burst V3");
    const stopRetouch = writeWithRetouch(p, v3);

    await expect(async () => {
      await page.goto(f.url("/hmr-burst"));
      await expect(testId(page, "hmr-burst")).toHaveText("Burst V3", {
        timeout: 2000,
      });
    }).toPass({ timeout: ROUTE_CHANGE_TIMEOUT });
    stopRetouch();
  });

  test("should handle burst multiple name changes", async ({ page }) => {
    const p = urlsPath();
    const original = readUrls();

    // 3 rapid writes, each renaming a different route name
    const w1 = original.replace('{ name: "about" }', '{ name: "aboutV1" }');
    saveAndWrite(p, w1);

    const w2 = w1.replace('{ name: "counter" }', '{ name: "counterV1" }');
    fs.writeFileSync(p, w2, "utf-8");

    const w3 = w2.replace('{ name: "home" }', '{ name: "homeV1" }');
    const stopRetouch = writeWithRetouch(p, w3);

    // All routes should still serve at their original URLs
    await expect(async () => {
      await page.goto(f.url("/about"));
      await expect(testId(page, "about-page")).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: ROUTE_CHANGE_TIMEOUT });
    stopRetouch();

    await page.goto(f.url("/counter"));
    await expect(testId(page, "counter-page")).toBeVisible();

    await page.goto(f.url("/"));
    await expect(testId(page, "home-page")).toBeVisible();
  });

  // -- Group 3: Include Patterns --

  test("should remove included routes when include is commented out", async ({
    page,
  }) => {
    // Verify route works initially
    await page.goto(f.url("/composition"));
    await waitForHydration(page);
    await expect(testId(page, "composition-index")).toBeVisible();

    const content = readUrls();
    const modified = content.replace(
      /include\("\/composition", compositionPatterns,\s*\{[^}]*name:\s*"composition"[^}]*\}\s*\),/,
      '// include("/composition", compositionPatterns, { name: "composition" }),',
    );
    expect(modified).not.toBe(content);
    const stopRetouch = writeWithRetouch(urlsPath(), modified);

    await expect(async () => {
      await page.goto(f.url("/composition"));
      await expect(testId(page, "catch-all-page")).toBeVisible({
        timeout: 2000,
      });
    }).toPass({ timeout: ROUTE_CHANGE_TIMEOUT });
    stopRetouch();
  });

  test("should restore included routes when include is uncommented", async ({
    page,
  }) => {
    const content = readUrls();
    const removed = content.replace(
      /include\("\/composition", compositionPatterns,\s*\{[^}]*name:\s*"composition"[^}]*\}\s*\),/,
      '// include("/composition", compositionPatterns, { name: "composition" }),',
    );
    let stopRetouch = writeWithRetouch(urlsPath(), removed);

    // Wait for removal to take effect
    await expect(async () => {
      await page.goto(f.url("/composition"));
      await expect(testId(page, "catch-all-page")).toBeVisible({
        timeout: 2000,
      });
    }).toPass({ timeout: ROUTE_CHANGE_TIMEOUT });
    stopRetouch();

    // Restore original
    stopRetouch = writeWithRetouch(urlsPath(), content);

    await expect(async () => {
      await page.goto(f.url("/composition"));
      await expect(testId(page, "composition-index")).toBeVisible({
        timeout: 2000,
      });
    }).toPass({ timeout: ROUTE_CHANGE_TIMEOUT });
    stopRetouch();
  });

  // -- Group 4: Layout Mutations --

  test("should render new layout wrapper after adding layout()", async ({
    page,
  }) => {
    const content = readUrls();

    // Add Outlet import and wrap theme route in a layout
    let modified = content.replace(
      'import { urls, cookies, type ResponseHandlerContext } from "@rangojs/router";',
      `import { urls, cookies, type ResponseHandlerContext } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";`,
    );
    modified = modified.replace(
      'path("/theme", ThemePage, { name: "theme" }),',
      `layout(() => <div data-testid="hmr-layout-wrapper"><Outlet /></div>, () => [
            path("/theme", ThemePage, { name: "theme" }),
          ]),`,
    );
    expect(modified).not.toBe(content);
    const stopRetouch = writeWithRetouch(urlsPath(), modified);

    await expect(async () => {
      await page.goto(f.url("/theme"));
      await expect(
        page.locator('[data-testid="hmr-layout-wrapper"]'),
      ).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: ROUTE_CHANGE_TIMEOUT });
    stopRetouch();

    // Theme content should still render inside the layout
    await expect(page.locator(".theme-page")).toBeVisible();
  });

  test("should unwrap routes when layout() is removed", async ({ page }) => {
    // Verify layout exists initially
    await page.goto(f.url("/proactive-cache"));
    await waitForHydration(page);
    await expect(testId(page, "proactive-cache-layout")).toBeVisible();
    await expect(testId(page, "proactive-index-page")).toBeVisible();

    const content = readUrls();
    const modified = content.replace(
      `layout(<ProactiveCacheLayout />, () => [
            path("/proactive-cache", ProactiveCacheIndexPage, {
              name: "proactiveCache",
            }),
            path("/proactive-cache/item-a", ProactiveCacheItemAPage, {
              name: "proactiveCacheItemA",
            }),
            path("/proactive-cache/item-b", ProactiveCacheItemBPage, {
              name: "proactiveCacheItemB",
            }),
          ]),`,
      `path("/proactive-cache", ProactiveCacheIndexPage, {
              name: "proactiveCache",
            }),
            path("/proactive-cache/item-a", ProactiveCacheItemAPage, {
              name: "proactiveCacheItemA",
            }),
            path("/proactive-cache/item-b", ProactiveCacheItemBPage, {
              name: "proactiveCacheItemB",
            }),`,
    );
    expect(modified).not.toBe(content);
    const stopRetouch = writeWithRetouch(urlsPath(), modified);

    await expect(async () => {
      await page.goto(f.url("/proactive-cache"));
      await expect(testId(page, "proactive-index-page")).toBeVisible({
        timeout: 2000,
      });
      // Layout should no longer be present — only passes after HMR processes
      await expect(testId(page, "proactive-cache-layout")).not.toBeVisible({
        timeout: 2000,
      });
    }).toPass({ timeout: ROUTE_CHANGE_TIMEOUT });
    stopRetouch();
  });

  // -- Group 5: Parallel Route Mutations --

  test("should remove parallel content when parallel() is removed", async ({
    page,
  }) => {
    // Verify sidebar renders initially
    await page.goto(f.url("/blog"));
    await waitForHydration(page);
    await expect(testId(page, "blog-index")).toBeVisible();
    // Sidebar or its skeleton should be present
    await expect(
      testId(page, "blog-sidebar").or(testId(page, "sidebar-skeleton")),
    ).toBeVisible();

    const content = readUrls();
    const modified = content.replace(
      `parallel({ "@sidebar": BlogSidebarHandler }, () => [
            loader(BlogSidebarLoader, () => [cache()]),
            loading(<SidebarSkeleton />),
          ]),`,
      `// parallel removed for HMR test`,
    );
    expect(modified).not.toBe(content);
    const stopRetouch = writeWithRetouch(urlsPath(), modified);

    await expect(async () => {
      await page.goto(f.url("/blog"));
      await expect(testId(page, "blog-index")).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: ROUTE_CHANGE_TIMEOUT });
    stopRetouch();

    // Sidebar and skeleton should both be gone
    await expect(testId(page, "blog-sidebar")).not.toBeVisible();
    await expect(testId(page, "sidebar-skeleton")).not.toBeVisible();
  });

  test("should restore parallel content when parallel() is re-added", async ({
    page,
  }) => {
    const content = readUrls();
    const removed = content.replace(
      `parallel({ "@sidebar": BlogSidebarHandler }, () => [
            loader(BlogSidebarLoader, () => [cache()]),
            loading(<SidebarSkeleton />),
          ]),`,
      `// parallel removed for HMR test`,
    );
    let stopRetouch = writeWithRetouch(urlsPath(), removed);

    // Wait for removal to take effect
    await expect(async () => {
      await page.goto(f.url("/blog"));
      await expect(testId(page, "blog-index")).toBeVisible({ timeout: 2000 });
      await expect(testId(page, "blog-sidebar")).not.toBeVisible();
      await expect(testId(page, "sidebar-skeleton")).not.toBeVisible();
    }).toPass({ timeout: ROUTE_CHANGE_TIMEOUT });
    stopRetouch();

    // Restore original
    stopRetouch = writeWithRetouch(urlsPath(), content);

    await expect(async () => {
      await page.goto(f.url("/blog"));
      await expect(
        testId(page, "blog-sidebar").or(testId(page, "sidebar-skeleton")),
      ).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: ROUTE_CHANGE_TIMEOUT });
    stopRetouch();
  });
});
