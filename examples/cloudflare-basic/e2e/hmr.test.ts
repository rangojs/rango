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

// Skip on CI due to known wrangler/workerd issues on Linux
// See: https://github.com/cloudflare/workers-sdk/issues/6280
test.skip(!!process.env.CI, "Skipped on CI due to wrangler/workerd Linux issues");

test.describe("hmr", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  // Store original file contents for cleanup
  const originalContents = new Map<string, string>();

  test.afterAll(() => {
    // Restore all modified files to avoid git conflicts
    for (const [filePath, content] of originalContents) {
      fs.writeFileSync(filePath, content, "utf-8");
    }
  });

  async function triggerHMRAndWait(page: Page, filePath: string): Promise<void> {
    const fullPath = path.join(f.root, filePath);
    const content = fs.readFileSync(fullPath, "utf-8");

    // Save original content on first modification
    if (!originalContents.has(fullPath)) {
      originalContents.set(fullPath, content);
    }

    const marker = `// HMR trigger: ${Date.now()}`;
    const newContent = content.includes("// HMR trigger:")
      ? content.replace(/\/\/ HMR trigger: \d+/, marker)
      : content + `\n${marker}\n`;

    const hmrComplete = page.waitForEvent("console", {
      predicate: (msg) => msg.text().includes("RSC stream complete"),
      timeout: 15000,
    });

    fs.writeFileSync(fullPath, newContent, "utf-8");

    await hmrComplete;
    await page.waitForTimeout(200);
  }

  test("should update content after HMR without page reload", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await expect(testId(page, "home-page")).toBeVisible();

    await using __ = await expectNoReload(page);

    await triggerHMRAndWait(page, "src/handlers/home.tsx");

    await expect(testId(page, "home-page")).toBeVisible();
  });

  test("should update about page content after HMR", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/about"));
    await waitForHydration(page);

    await expect(testId(page, "about-page")).toBeVisible();
    await expect(testId(page, "about-title")).toHaveText("About");

    await using __ = await expectNoReload(page);

    await triggerHMRAndWait(page, "src/handlers/about.tsx");

    await expect(testId(page, "about-page")).toBeVisible();
    await expect(testId(page, "about-title")).toHaveText("About");
  });

  test("should preserve navigation after HMR", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await testId(page, "nav-about").click();
    await expect(testId(page, "about-page")).toBeVisible();

    await using __ = await expectNoReload(page);

    await triggerHMRAndWait(page, "src/handlers/about.tsx");

    await expect(testId(page, "about-page")).toBeVisible();
    await expect(testId(page, "nav")).toBeVisible();

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

    await triggerHMRAndWait(page, "src/handlers/counter.tsx");

    await expect(testId(page, "counter-page")).toBeVisible();
    const countAfter = await testId(page, "counter-value").textContent();
    expect(countAfter).toBe(countBefore);
  });
});
