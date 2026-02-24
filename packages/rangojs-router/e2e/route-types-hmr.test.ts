import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Tests for route type generation HMR:
 * 1. Adding a new named route should regenerate the types file
 * 2. Removing a route should regenerate the types file
 * 3. Touching a non-route file should not change the types file
 * 4. Renaming a route should update the types file
 * 5. Adding a search schema should update the types file
 * 6. Adding/removing an include() should update the types file
 * 7. Runtime reverse() should reflect route changes (add/remove/rename)
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
  const mainUrlsPath = path.resolve("./e2e/test-app/src/urls.tsx");
  const genFilePath = path.resolve(
    "./e2e/test-app/src/router.named-routes.gen.ts"
  );
  const handlersPath = path.resolve(
    "./e2e/test-app/src/urls/blog.handlers.tsx"
  );

  let originalBlogContent: string;
  let originalMainUrlsContent: string;

  test.beforeAll(async () => {
    originalBlogContent = await fs.readFile(blogUrlsPath, "utf-8");
    originalMainUrlsContent = await fs.readFile(mainUrlsPath, "utf-8");
  });

  test.afterEach(async () => {
    await fs.writeFile(blogUrlsPath, originalBlogContent);
    await fs.writeFile(mainUrlsPath, originalMainUrlsContent);
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

  test("should update route types when a route is renamed", async () => {
    const before = await fs.readFile(genFilePath, "utf-8");
    expect(before).toContain('"blog.post"');
    expect(before).not.toContain('"blog.article"');

    // Rename "post" -> "article"
    const modified = originalBlogContent.replace(
      '{ name: "post" }',
      '{ name: "article" }'
    );
    expect(modified).not.toBe(originalBlogContent);
    await fs.writeFile(blogUrlsPath, modified);

    await expect(async () => {
      const after = await fs.readFile(genFilePath, "utf-8");
      expect(after).not.toContain('"blog.post"');
      expect(after).toContain('"blog.article"');
    }).toPass({ timeout: 10000 });
  });

  test("should update route types when a search schema is added", async () => {
    const before = await fs.readFile(genFilePath, "utf-8");
    // blog.post is a plain string pattern, no search schema
    expect(before).toContain('"blog.post": "/blog/:postId"');

    // Add a search schema to the post route
    const modified = originalBlogContent.replace(
      '{ name: "post" }',
      '{ name: "post", search: { tag: "string", draft: "boolean?" } }'
    );
    expect(modified).not.toBe(originalBlogContent);
    await fs.writeFile(blogUrlsPath, modified);

    await expect(async () => {
      const after = await fs.readFile(genFilePath, "utf-8");
      // Should now be an object with path and search properties
      expect(after).toContain('"blog.post"');
      expect(after).toContain('tag: "string"');
      expect(after).toContain('draft: "boolean?"');
    }).toPass({ timeout: 10000 });
  });

  test("should update route types when a search schema is removed", async () => {
    // First add a search schema
    const withSchema = originalBlogContent.replace(
      '{ name: "post" }',
      '{ name: "post", search: { tag: "string", draft: "boolean?" } }'
    );
    await fs.writeFile(blogUrlsPath, withSchema);

    await expect(async () => {
      const content = await fs.readFile(genFilePath, "utf-8");
      expect(content).toContain('tag: "string"');
      expect(content).toContain('draft: "boolean?"');
    }).toPass({ timeout: 10000 });

    // Remove the search schema by restoring the original
    await fs.writeFile(blogUrlsPath, originalBlogContent);

    await expect(async () => {
      const after = await fs.readFile(genFilePath, "utf-8");
      // Should revert to a plain string pattern (no search object)
      expect(after).toContain('"blog.post": "/blog/:postId"');
      expect(after).not.toContain('tag: "string"');
      expect(after).not.toContain('draft: "boolean?"');
    }).toPass({ timeout: 10000 });
  });

  test("should update route types when an include is removed", async () => {
    const before = await fs.readFile(genFilePath, "utf-8");
    expect(before).toContain('"blog.index"');
    expect(before).toContain('"blog.post"');

    // Comment out the blog include
    const modified = originalMainUrlsContent.replace(
      'include("/blog", blogPatterns, { name: "blog" }),',
      '// include("/blog", blogPatterns, { name: "blog" }),'
    );
    expect(modified).not.toBe(originalMainUrlsContent);
    await fs.writeFile(mainUrlsPath, modified);

    await expect(async () => {
      const after = await fs.readFile(genFilePath, "utf-8");
      expect(after).not.toContain('"blog.index"');
      expect(after).not.toContain('"blog.post"');
    }).toPass({ timeout: 10000 });
  });

  test("should update route types when an include is re-added", async () => {
    // First remove the blog include
    const removed = originalMainUrlsContent.replace(
      'include("/blog", blogPatterns, { name: "blog" }),',
      '// include("/blog", blogPatterns, { name: "blog" }),'
    );
    await fs.writeFile(mainUrlsPath, removed);

    await expect(async () => {
      const content = await fs.readFile(genFilePath, "utf-8");
      expect(content).not.toContain('"blog.index"');
    }).toPass({ timeout: 10000 });

    // Restore the include
    await fs.writeFile(mainUrlsPath, originalMainUrlsContent);

    await expect(async () => {
      const after = await fs.readFile(genFilePath, "utf-8");
      expect(after).toContain('"blog.index"');
      expect(after).toContain('"blog.post"');
    }).toPass({ timeout: 10000 });
  });

  // -- Runtime reverse() tests --
  // Verify that the runtime manifest used by ctx.reverse() stays in sync
  // with the gen file after HMR route changes.

  async function queryReverse(names: string[]): Promise<Record<string, string | null>> {
    const params = names.map((n) => `name=${encodeURIComponent(n)}`).join("&");
    const res = await fetch(f.url(`/__debug/reverse-test?${params}`));
    const envelope = await res.json();
    return envelope.data;
  }

  test("reverse() should resolve a newly added route", async () => {
    // Verify blog.comments does not resolve before
    const before = await queryReverse(["blog.comments"]);
    expect(before["blog.comments"]).toBeNull();

    // Add the route
    const modified = originalBlogContent.replace(
      'path("/:postId", BlogPostHandler, { name: "post" }),',
      `path("/:postId", BlogPostHandler, { name: "post" }),
    path("/:postId/comments", BlogPostHandler, { name: "comments" }),`
    );
    await fs.writeFile(blogUrlsPath, modified);

    // Wait for gen file to update (confirms watcher ran)
    await expect(async () => {
      const content = await fs.readFile(genFilePath, "utf-8");
      expect(content).toContain('"blog.comments"');
    }).toPass({ timeout: 10000 });

    // Verify reverse() now resolves the new route
    await expect(async () => {
      const after = await queryReverse(["blog.comments"]);
      expect(after["blog.comments"]).toBe("/blog/:postId/comments");
    }).toPass({ timeout: 5000 });
  });

  test("reverse() should not resolve a removed route", async () => {
    // First add the route
    const modified = originalBlogContent.replace(
      'path("/:postId", BlogPostHandler, { name: "post" }),',
      `path("/:postId", BlogPostHandler, { name: "post" }),
    path("/:postId/comments", BlogPostHandler, { name: "comments" }),`
    );
    await fs.writeFile(blogUrlsPath, modified);

    await expect(async () => {
      const result = await queryReverse(["blog.comments"]);
      expect(result["blog.comments"]).toBe("/blog/:postId/comments");
    }).toPass({ timeout: 10000 });

    // Remove the route by restoring original
    await fs.writeFile(blogUrlsPath, originalBlogContent);

    // Wait for gen file to update
    await expect(async () => {
      const content = await fs.readFile(genFilePath, "utf-8");
      expect(content).not.toContain('"blog.comments"');
    }).toPass({ timeout: 10000 });

    // Verify reverse() no longer resolves it
    await expect(async () => {
      const after = await queryReverse(["blog.comments"]);
      expect(after["blog.comments"]).toBeNull();
    }).toPass({ timeout: 5000 });
  });

  // Note: rename tests for reverse() are intentionally omitted here.
  // Renaming a route (e.g. "blog.post" -> "blog.article") breaks
  // module-level reverse() calls that reference the old name, causing
  // the entire router module to fail on re-evaluation. This is expected
  // behavior — the gen file (tested above) correctly reflects renames.

  // -- Gen file deletion recovery tests --
  // Verify the watcher recreates deleted gen files and the virtual module
  // re-evaluates correctly.

  test("should restore gen file when it is manually edited", async () => {
    const before = await fs.readFile(genFilePath, "utf-8");
    expect(before).toContain('"blog.index": "/blog"');

    const tampered = before.replace(
      '"blog.index": "/blog"',
      '"blog.index": "/tampered-blog"',
    );
    expect(tampered).not.toBe(before);
    await fs.writeFile(genFilePath, tampered);

    // Change watcher should detect external tampering and regenerate.
    await expect(async () => {
      const healed = await fs.readFile(genFilePath, "utf-8");
      expect(healed).toContain('"blog.index": "/blog"');
      expect(healed).not.toContain("/tampered-blog");
    }).toPass({ timeout: 10000 });

    // Runtime manifest should stay in sync with repaired file.
    await expect(async () => {
      const after = await queryReverse(["blog.index"]);
      expect(after["blog.index"]).toBe("/blog");
    }).toPass({ timeout: 5000 });
  });

  test("should recreate gen file when it is deleted", async () => {
    // Verify gen file exists with expected routes
    const before = await fs.readFile(genFilePath, "utf-8");
    expect(before).toContain('"blog.index"');
    expect(before).toContain('"blog.post"');

    // Delete the gen file
    await fs.unlink(genFilePath);

    // Verify it doesn't exist
    await expect(fs.access(genFilePath)).rejects.toThrow();

    // The unlink handler should recreate it
    await expect(async () => {
      const after = await fs.readFile(genFilePath, "utf-8");
      expect(after).toContain('"blog.index"');
      expect(after).toContain('"blog.post"');
    }).toPass({ timeout: 10000 });
  });

  test("reverse() should still work after gen file deletion and recreation", async () => {
    // Verify reverse() works before deletion
    const before = await queryReverse(["blog.index"]);
    expect(before["blog.index"]).toBe("/blog");

    // Delete the gen file
    await fs.unlink(genFilePath);

    // Wait for recreation
    await expect(async () => {
      await fs.access(genFilePath);
    }).toPass({ timeout: 10000 });

    // Verify reverse() still resolves after recreation
    await expect(async () => {
      const after = await queryReverse(["blog.index"]);
      expect(after["blog.index"]).toBe("/blog");
    }).toPass({ timeout: 5000 });
  });
});
