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

  // Store original file content for cleanup
  let originalContent: string | null = null;
  let handlerFilePath: string;

  /**
   * Remove any existing HMR trigger comments from content.
   * This ensures we restore to a clean state.
   */
  function stripHmrMarkers(content: string): string {
    return content.replace(/\n?\/\/ HMR trigger: \d+\n?/g, "");
  }

  test.beforeAll(() => {
    handlerFilePath = path.join(f.root, "src/urls.tsx");
    const currentContent = fs.readFileSync(handlerFilePath, "utf-8");
    // Store content without any existing HMR markers (clean state)
    originalContent = stripHmrMarkers(currentContent);
    // Also immediately clean up any leftover markers from previous runs
    if (currentContent !== originalContent) {
      fs.writeFileSync(handlerFilePath, originalContent, "utf-8");
    }
  });

  test.afterAll(() => {
    // Restore original file content to avoid git conflicts
    if (originalContent !== null) {
      fs.writeFileSync(handlerFilePath, originalContent, "utf-8");
    }
  });

  // Also clean up after each test for extra safety
  test.afterEach(() => {
    if (originalContent !== null) {
      fs.writeFileSync(handlerFilePath, originalContent, "utf-8");
    }
  });

  // Helper to trigger HMR by touching a server component file and waiting for completion
  async function triggerHMRAndWait(page: Page): Promise<void> {
    // Modify urls.tsx (server component) to trigger RSC HMR
    const content = fs.readFileSync(handlerFilePath, "utf-8");

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
    fs.writeFileSync(handlerFilePath, newContent, "utf-8");

    // Wait for HMR to complete
    await hmrComplete;

    // Small delay to ensure state is settled
    await page.waitForTimeout(200);
  }

  test.fixme("isStreaming should reset to false after HMR on simple page", async ({
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

  test.fixme("isStreaming should reset to false after HMR on streaming page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Navigate to a streaming page first
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Extra wait to ensure all event handlers are attached
    // Under load, React hydration might complete but handlers may still be attaching
    await page.waitForTimeout(100);

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
