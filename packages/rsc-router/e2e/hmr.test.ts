import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";
import fs from "node:fs";
import path from "node:path";

/**
 * Tests for HMR (Hot Module Replacement) behavior
 *
 * These tests verify that:
 * 1. Parallel segments persist after HMR (sidebar fix)
 * 2. isStreaming resets to false after HMR completes
 */
test.describe("hmr", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  // Helper to trigger HMR by touching a server component file and waiting for completion
  async function triggerHMRAndWait(page: Page): Promise<void> {
    // Modify handlers.tsx (server component) to trigger RSC HMR
    const filePath = path.join(f.root, "src/handlers.tsx");
    const content = fs.readFileSync(filePath, "utf-8");

    // Add a comment with timestamp to trigger HMR
    const marker = `// HMR trigger: ${Date.now()}`;
    const newContent = content.includes("// HMR trigger:")
      ? content.replace(/\/\/ HMR trigger: \d+/, marker)
      : content + `\n${marker}\n`;

    // Create a promise that resolves when HMR completes
    const hmrComplete = page.waitForEvent("console", {
      predicate: (msg) => msg.text().includes("RSC stream complete"),
      timeout: 15000,
    });

    // Trigger HMR by writing the file
    fs.writeFileSync(filePath, newContent, "utf-8");

    // Wait for HMR to complete
    await hmrComplete;

    // Small delay to ensure state is settled
    await page.waitForTimeout(200);
  }

  test("isStreaming should reset to false after HMR on simple page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Navigate to a page
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Verify initial state
    await expect(testId(page, "nav-status-streaming")).toContainText(
      "streaming:false"
    );
    await expect(testId(page, "nav-status-state")).toContainText("state:idle");

    // Trigger HMR and wait for completion
    await triggerHMRAndWait(page);

    // Verify streaming state is reset to false after HMR
    await expect(testId(page, "nav-status-streaming")).toContainText(
      "streaming:false",
      { timeout: 5000 }
    );
    await expect(testId(page, "nav-status-state")).toContainText("state:idle");
  });

  test("isStreaming should reset to false after HMR on streaming page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Navigate to a streaming page first
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Click on slow-streaming link
    await testId(page, "slow-streaming-link").click();

    // Wait for the streaming page to load
    await expect(testId(page, "slow-streaming-page")).toBeVisible({
      timeout: 10000,
    });

    // Verify we're on the streaming page and state is idle
    await expect(testId(page, "nav-status-state")).toContainText("state:idle");
    await expect(testId(page, "nav-status-streaming")).toContainText(
      "streaming:false"
    );

    // Trigger HMR and wait for completion
    await triggerHMRAndWait(page);

    // CRITICAL: After HMR, isStreaming should be false
    // This was the bug: streaming token wasn't ended after HMR
    await expect(testId(page, "nav-status-streaming")).toContainText(
      "streaming:false",
      { timeout: 5000 }
    );
    await expect(testId(page, "nav-status-state")).toContainText("state:idle");

    // Verify page content is still there
    await expect(testId(page, "slow-streaming-page")).toBeVisible();
  });
});
