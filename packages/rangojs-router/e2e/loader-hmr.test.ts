import { expect, test, type APIRequestContext } from "@playwright/test";
import { useFixture } from "./fixture";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Tests for loader HMR (Hot Module Replacement):
 * 1. Adding a new fetchable loader should make it immediately available
 * 2. Removing a loader should return 404
 * 3. Existing loaders should continue to work after HMR
 *
 * These tests must run serially since they modify the same file.
 */

test.describe.serial("loader-hmr", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.setTimeout(30000);

  const loadersPath = path.resolve("./e2e/test-app/src/loaders.ts");
  let originalContent: string;

  // Save original content before tests
  test.beforeAll(async () => {
    originalContent = await fs.readFile(loadersPath, "utf-8");
  });

  // Restore original content after each test
  test.afterEach(async () => {
    await fs.writeFile(loadersPath, originalContent);
    // Wait for HMR to process the restore
    await new Promise((r) => setTimeout(r, 500));
  });

  async function waitForLoaderResponse(
    request: APIRequestContext,
    url: string,
    expectedStatus: number,
  ) {
    let lastBody = "";
    await expect
      .poll(
        async () => {
          const response = await request.get(url, {
            headers: { Accept: "text/x-component" },
          });
          lastBody = await response.text();
          return response.status();
        },
        {
          timeout: 10_000,
          intervals: [200, 400, 800],
          message: `waiting for ${url} to return ${expectedStatus}`,
        },
      )
      .toBe(expectedStatus);

    return lastBody;
  }

  test("should make new fetchable loader available after HMR", async ({
    request,
  }) => {
    // Add a new fetchable loader
    const newLoaderCode = `
// HMR Test: Dynamically added loader
let hmrTestCount = 0;

export const HMRDynamicLoader = createLoader(
  async (ctx) => {
    hmrTestCount++;
    return {
      message: "HMR Dynamic Loader Works!",
      count: hmrTestCount,
      timestamp: new Date().toISOString(),
    };
  },
  true // Enable fetchable
);
`;

    const modifiedContent = originalContent + newLoaderCode;
    await fs.writeFile(loadersPath, modifiedContent);

    // Wait for HMR to process
    await new Promise((r) => setTimeout(r, 1000));

    // Test that the new loader is accessible
    const text = await waitForLoaderResponse(
      request,
      f.url("/fetch-loader?_rsc_loader=src/loaders.ts%23HMRDynamicLoader"),
      200,
    );
    expect(text).toContain("HMR Dynamic Loader Works!");
  });

  test("should return 404 for removed loader after HMR", async ({ request }) => {
    // First add a loader
    const newLoaderCode = `
// HMR Test: Loader to be removed
export const HMRRemovableLoader = createLoader(
  async () => ({ message: "Will be removed" }),
  true
);
`;

    await fs.writeFile(loadersPath, originalContent + newLoaderCode);
    await new Promise((r) => setTimeout(r, 1000));

    // Verify it's accessible
    await waitForLoaderResponse(
      request,
      f.url("/fetch-loader?_rsc_loader=src/loaders.ts%23HMRRemovableLoader"),
      200,
    );

    // Now remove it by restoring original content
    await fs.writeFile(loadersPath, originalContent);
    await new Promise((r) => setTimeout(r, 1000));

    // Test that the loader returns 404
    const text = await waitForLoaderResponse(
      request,
      f.url("/fetch-loader?_rsc_loader=src/loaders.ts%23HMRRemovableLoader"),
      404,
    );
    expect(text).toContain("not found");
  });

  test("existing loaders should continue to work after HMR changes", async ({
    request,
  }) => {
    // Fetch from existing loader first
    const text1 = await waitForLoaderResponse(
      request,
      f.url("/fetch-loader?_rsc_loader=src/loaders.ts%23FetchableTestLoader"),
      200,
    );
    expect(text1).toContain("Fetched via GET!");

    // Add a new loader (triggers HMR)
    const newLoaderCode = `
// HMR Test: Another loader
export const HMRAnotherLoader = createLoader(
  async () => ({ message: "Another loader" }),
  true
);
`;
    await fs.writeFile(loadersPath, originalContent + newLoaderCode);
    await new Promise((r) => setTimeout(r, 1000));

    // Existing loader should still work
    const text2 = await waitForLoaderResponse(
      request,
      f.url("/fetch-loader?_rsc_loader=src/loaders.ts%23FetchableTestLoader"),
      200,
    );
    expect(text2).toContain("Fetched via GET!");
  });
});
