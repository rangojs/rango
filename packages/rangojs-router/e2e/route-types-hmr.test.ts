import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Tests for route type generation HMR:
 * 1. Adding a new named route should regenerate the types file
 * 2. Removing a route should regenerate the types file
 * 3. Touching a non-route file should not change the types file
 *
 * These tests must run serially since they modify shared source files.
 */

test.describe.serial("route-types-hmr", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });

  test.setTimeout(30000);

  const blogUrlsPath = path.resolve("./e2e/test-app/src/urls/blog.tsx");
  const genFilePath = path.resolve(
    "./e2e/test-app/src/named-routes.router_0.gen.ts"
  );
  const handlersPath = path.resolve(
    "./e2e/test-app/src/urls/blog.handlers.tsx"
  );

  let originalBlogContent: string;

  test.beforeAll(async () => {
    originalBlogContent = await fs.readFile(blogUrlsPath, "utf-8");
  });

  test.afterEach(async () => {
    await fs.writeFile(blogUrlsPath, originalBlogContent);
    // Wait for HMR + re-discovery to process the restore
    await new Promise((r) => setTimeout(r, 2000));
  });

  test("should regenerate route types when a new route is added", async () => {
    // Read the gen file before modification
    const before = await fs.readFile(genFilePath, "utf-8");
    expect(before).not.toContain('"blog.comments"');

    // Add a new named route to blog urls
    const modified = originalBlogContent.replace(
      'path("/:postId", BlogPostHandler, { name: "post" }),',
      `path("/:postId", BlogPostHandler, { name: "post" }),
    path("/:postId/comments", BlogPostHandler, { name: "comments" }),`
    );
    expect(modified).not.toBe(originalBlogContent);
    await fs.writeFile(blogUrlsPath, modified);

    // Wait for HMR + re-discovery + file write
    await expect(async () => {
      const after = await fs.readFile(genFilePath, "utf-8");
      expect(after).toContain('"blog.comments"');
      expect(after).toContain("/blog/:postId/comments");
    }).toPass({ timeout: 10000 });
  });

  test("should regenerate route types when a route is removed", async () => {
    // First add the route
    const modified = originalBlogContent.replace(
      'path("/:postId", BlogPostHandler, { name: "post" }),',
      `path("/:postId", BlogPostHandler, { name: "post" }),
    path("/:postId/comments", BlogPostHandler, { name: "comments" }),`
    );
    await fs.writeFile(blogUrlsPath, modified);

    // Wait for it to appear
    await expect(async () => {
      const content = await fs.readFile(genFilePath, "utf-8");
      expect(content).toContain('"blog.comments"');
    }).toPass({ timeout: 10000 });

    // Now remove it by restoring original
    await fs.writeFile(blogUrlsPath, originalBlogContent);

    // Wait for it to disappear
    await expect(async () => {
      const content = await fs.readFile(genFilePath, "utf-8");
      expect(content).not.toContain('"blog.comments"');
    }).toPass({ timeout: 10000 });
  });

  test("should not overwrite when routes have not changed", async () => {
    // Get the initial mtime of the gen file
    const statBefore = await fs.stat(genFilePath);

    // Touch a handler file (not a URL definition file)
    const handlerContent = await fs.readFile(handlersPath, "utf-8");
    await fs.writeFile(handlersPath, handlerContent + "\n// touch");

    // Negative assertion: wait long enough for HMR + re-discovery (100ms debounce)
    // to complete, then verify the file was NOT rewritten.
    await new Promise((r) => setTimeout(r, 2000));

    // mtime should not have changed since route patterns are identical
    const statAfter = await fs.stat(genFilePath);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);

    // Restore handler file
    await fs.writeFile(handlersPath, handlerContent);
    await new Promise((r) => setTimeout(r, 500));
  });
});
