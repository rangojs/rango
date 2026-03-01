import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  testId,
  expectNoReload,
} from "./helper";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

test.describe("hmr", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  // Restore git-tracked sources in case a prior timed-out test left
  // modified files on disk (afterEach does not run when workers crash).
  test.beforeAll(() => {
    try {
      execSync("git checkout -- src/pages/ src/urls.tsx", {
        cwd: f.root,
        stdio: "ignore",
      });
    } catch {}
  });

  // Store original file contents for cleanup
  const originalContents = new Map<string, string>();

  test.afterEach(() => {
    // Restore all modified files after each test to ensure clean state
    for (const [filePath, content] of originalContents) {
      fs.writeFileSync(filePath, content, "utf-8");
    }
    originalContents.clear();
  });

  /**
   * Trigger HMR by modifying a file and wait for the RSC stream to complete.
   * Optionally makes a visible content change and returns the expected new text.
   */
  async function triggerHMRAndWait(
    page: Page,
    filePath: string,
    options?: { visibleChange?: { search: string; replace: string } },
  ): Promise<{ expectedText?: string }> {
    const fullPath = path.join(f.root, filePath);
    const content = fs.readFileSync(fullPath, "utf-8");

    // Save original content on first modification
    if (!originalContents.has(fullPath)) {
      originalContents.set(fullPath, content);
    }

    let newContent = content;
    let expectedText: string | undefined;

    // Apply visible change if specified
    if (options?.visibleChange) {
      const { search, replace } = options.visibleChange;
      if (content.includes(search)) {
        newContent = content.replace(search, replace);
        expectedText = replace;
      }
    }

    // Always add/update HMR trigger marker to ensure file change is detected
    const marker = `// HMR trigger: ${Date.now()}`;
    newContent = newContent.includes("// HMR trigger:")
      ? newContent.replace(/\/\/ HMR trigger: \d+/, marker)
      : newContent + `\n${marker}\n`;

    const hmrComplete = page.waitForEvent("console", {
      predicate: (msg) => msg.text().includes("RSC stream complete"),
      timeout: 15000,
    });

    fs.writeFileSync(fullPath, newContent, "utf-8");

    await hmrComplete;
    await page.waitForTimeout(200);

    return { expectedText };
  }

  test("should update content after HMR without page reload", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await expect(testId(page, "home-page")).toBeVisible();

    await using __ = await expectNoReload(page);

    await triggerHMRAndWait(page, "src/pages/home.tsx");

    await expect(testId(page, "home-page")).toBeVisible();
  });

  test("should update about page content after HMR", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/about"));
    await waitForHydration(page);

    await expect(testId(page, "about-page")).toBeVisible();
    await expect(testId(page, "about-title")).toHaveText("About");

    await using __ = await expectNoReload(page);

    // Make a visible change and verify it appears
    const { expectedText } = await triggerHMRAndWait(
      page,
      "src/pages/about.tsx",
      {
        visibleChange: {
          search: ">About</h1>",
          replace: ">About (HMR Updated)</h1>",
        },
      },
    );

    await expect(testId(page, "about-page")).toBeVisible();
    await expect(testId(page, "about-title")).toHaveText("About (HMR Updated)");
  });

  test("should preserve navigation after HMR", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await testId(page, "nav-about").click();
    await expect(testId(page, "about-page")).toBeVisible();
    await expect(testId(page, "about-title")).toHaveText("About");

    // Only monitor for reload during HMR, not during subsequent navigation
    {
      await using __ = await expectNoReload(page);

      // Make a visible change and verify it appears without reload
      await triggerHMRAndWait(page, "src/pages/about.tsx", {
        visibleChange: {
          search: ">About</h1>",
          replace: ">About (HMR Updated)</h1>",
        },
      });

      await expect(testId(page, "about-page")).toBeVisible();
      await expect(testId(page, "about-title")).toHaveText(
        "About (HMR Updated)",
      );
      await expect(testId(page, "nav")).toBeVisible();
    }

    // Navigation after HMR should still work
    await testId(page, "nav-home").click();
    await expect(testId(page, "home-page")).toBeVisible();
  });

  test("should preserve counter state after HMR", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/counter"));
    await waitForHydration(page);

    await expect(testId(page, "counter-page")).toBeVisible();

    await testId(page, "counter-increment").click();
    await expect(testId(page, "counter-pending")).not.toBeVisible({
      timeout: 10000,
    });

    const countBefore = await testId(page, "counter-value").textContent();

    await using __ = await expectNoReload(page);

    await triggerHMRAndWait(page, "src/pages/counter.tsx");

    await expect(testId(page, "counter-page")).toBeVisible();
    const countAfter = await testId(page, "counter-value").textContent();
    expect(countAfter).toBe(countBefore);
  });
});

test.describe.serial("hmr-route-mutations", () => {
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
    saveAndWrite(urlsPath(), modified);

    await expect(async () => {
      await page.goto(f.url("/hmr-test-route"));
      await expect(testId(page, "hmr-new-route")).toBeVisible({
        timeout: 2000,
      });
    }).toPass({ timeout: ROUTE_CHANGE_TIMEOUT });

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
    saveAndWrite(urlsPath(), modified);

    await expect(async () => {
      await page.goto(f.url("/about"));
      await expect(testId(page, "catch-all-page")).toBeVisible({
        timeout: 2000,
      });
    }).toPass({ timeout: ROUTE_CHANGE_TIMEOUT });
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
    saveAndWrite(urlsPath(), modified);

    // New path should work
    await expect(async () => {
      await page.goto(f.url("/about-us"));
      await expect(testId(page, "about-page")).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: ROUTE_CHANGE_TIMEOUT });

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
    saveAndWrite(urlsPath(), modified);

    await expect(async () => {
      await page.goto(f.url("/counter-v2"));
      await expect(testId(page, "counter-page")).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: ROUTE_CHANGE_TIMEOUT });

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
    fs.writeFileSync(p, v3, "utf-8");

    await expect(async () => {
      await page.goto(f.url("/hmr-burst"));
      await expect(testId(page, "hmr-burst")).toHaveText("Burst V3", {
        timeout: 2000,
      });
    }).toPass({ timeout: ROUTE_CHANGE_TIMEOUT });
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
    fs.writeFileSync(p, w3, "utf-8");

    // All routes should still serve at their original URLs
    await expect(async () => {
      await page.goto(f.url("/about"));
      await expect(testId(page, "about-page")).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: ROUTE_CHANGE_TIMEOUT });

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
    saveAndWrite(urlsPath(), modified);

    await expect(async () => {
      await page.goto(f.url("/composition"));
      await expect(testId(page, "catch-all-page")).toBeVisible({
        timeout: 2000,
      });
    }).toPass({ timeout: ROUTE_CHANGE_TIMEOUT });
  });

  test("should restore included routes when include is uncommented", async ({
    page,
  }) => {
    const content = readUrls();
    const removed = content.replace(
      /include\("\/composition", compositionPatterns,\s*\{[^}]*name:\s*"composition"[^}]*\}\s*\),/,
      '// include("/composition", compositionPatterns, { name: "composition" }),',
    );
    saveAndWrite(urlsPath(), removed);

    // Wait for removal to take effect
    await expect(async () => {
      await page.goto(f.url("/composition"));
      await expect(testId(page, "catch-all-page")).toBeVisible({
        timeout: 2000,
      });
    }).toPass({ timeout: ROUTE_CHANGE_TIMEOUT });

    // Restore original
    const stopRetouch = writeWithRetouch(urlsPath(), content);

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
      'import { urls, type ResponseHandlerContext } from "@rangojs/router";',
      `import { urls, type ResponseHandlerContext } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";`,
    );
    modified = modified.replace(
      'path("/theme", ThemePage, { name: "theme" }),',
      `layout(() => <div data-testid="hmr-layout-wrapper"><Outlet /></div>, () => [
            path("/theme", ThemePage, { name: "theme" }),
          ]),`,
    );
    expect(modified).not.toBe(content);
    saveAndWrite(urlsPath(), modified);

    await expect(async () => {
      await page.goto(f.url("/theme"));
      await expect(
        page.locator('[data-testid="hmr-layout-wrapper"]'),
      ).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: ROUTE_CHANGE_TIMEOUT });

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
    saveAndWrite(urlsPath(), modified);

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
    saveAndWrite(urlsPath(), modified);

    await expect(async () => {
      await page.goto(f.url("/blog"));
      await expect(testId(page, "blog-index")).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: ROUTE_CHANGE_TIMEOUT });

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
    saveAndWrite(urlsPath(), removed);

    // Wait for removal to take effect
    await expect(async () => {
      await page.goto(f.url("/blog"));
      await expect(testId(page, "blog-index")).toBeVisible({ timeout: 2000 });
      await expect(testId(page, "blog-sidebar")).not.toBeVisible();
      await expect(testId(page, "sidebar-skeleton")).not.toBeVisible();
    }).toPass({ timeout: ROUTE_CHANGE_TIMEOUT });

    // Restore original
    const stopRetouch = writeWithRetouch(urlsPath(), content);

    await expect(async () => {
      await page.goto(f.url("/blog"));
      await expect(
        testId(page, "blog-sidebar").or(testId(page, "sidebar-skeleton")),
      ).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: ROUTE_CHANGE_TIMEOUT });
    stopRetouch();
  });
});
