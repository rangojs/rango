import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";

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

// Filesystem watcher events can be slow on CI Linux runners under parallel
// load, so we use longer timeouts there.
const isCI = !!process.env.CI;
const WATCHER_TIMEOUT = isCI ? 30_000 : 10_000;
const RUNTIME_TIMEOUT = isCI ? 20_000 : 5_000;

// Skip on CI: the file watcher is unreliable on GitHub Actions runners when
// multiple Vite dev servers watch the same directory (shared webServer +
// isolated test server). Run locally before PRs that touch route types or
// the Vite plugin watcher.
test.describe.serial("route-types-hmr", () => {
  test.skip(isCI, "file watcher unreliable on CI — run locally");

  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });

  test.setTimeout(isCI ? 60_000 : 30_000);

  const blogUrlsPath = path.resolve("./e2e/test-app/src/urls/blog.tsx");
  const mainUrlsPath = path.resolve("./e2e/test-app/src/urls.tsx");
  const genFilePath = path.resolve(
    "./e2e/test-app/src/router.named-routes.gen.ts",
  );
  const handlersPath = path.resolve(
    "./e2e/test-app/src/urls/blog.handlers.tsx",
  );
  const factoryHmrPath = path.resolve(
    "./e2e/test-app/src/urls/factory-hmr.tsx",
  );

  let originalBlogContent: string;
  let originalMainUrlsContent: string;
  let originalHandlersContent: string;
  let originalFactoryHmrContent: string;
  let dirtyGuardMessage = "";

  test.beforeAll(async () => {
    // Check for uncommitted changes BEFORE touching files. If a developer
    // has local edits in the target files, bail out rather than overwriting.
    try {
      const dirty = execSync(
        `git diff --name-only -- "${blogUrlsPath}" "${mainUrlsPath}" "${handlersPath}" "${factoryHmrPath}"`,
        { encoding: "utf-8" },
      ).trim();
      if (dirty) {
        dirtyGuardMessage =
          `Source files have uncommitted changes (${dirty.replace(/\n/g, ", ")}). ` +
          `Restore them first: git checkout -- ${dirty.replace(/\n/g, " ")}`;
        return;
      }
    } catch {
      // Not a git repo or git not available — proceed anyway
    }

    // Read baselines from git object store (non-destructive) so that even
    // if a prior crashed run left modified files, we get the canonical
    // tracked versions without `git checkout --`.
    const repoRoot = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
    }).trim();

    function gitBaseline(absPath: string): string {
      const rel = path.relative(repoRoot, absPath);
      return execSync(`git show HEAD:${rel}`, { encoding: "utf-8" });
    }

    originalBlogContent = gitBaseline(blogUrlsPath);
    originalMainUrlsContent = gitBaseline(mainUrlsPath);
    originalHandlersContent = gitBaseline(handlersPath);
    originalFactoryHmrContent = gitBaseline(factoryHmrPath);

    // Write baselines to disk in case a prior crash left stale modifications.
    await fs.writeFile(blogUrlsPath, originalBlogContent);
    await fs.writeFile(mainUrlsPath, originalMainUrlsContent);
    await fs.writeFile(handlersPath, originalHandlersContent);
    await fs.writeFile(factoryHmrPath, originalFactoryHmrContent);
  });

  // Deferred skip: test.skip() cannot be called from beforeAll, so we
  // check the guard flag here and skip each test individually.
  test.beforeEach(() => {
    test.skip(dirtyGuardMessage.length > 0, dirtyGuardMessage);
  });

  test.afterEach(async () => {
    if (dirtyGuardMessage) return;
    await fs.writeFile(blogUrlsPath, originalBlogContent);
    await fs.writeFile(mainUrlsPath, originalMainUrlsContent);
    await fs.writeFile(handlersPath, originalHandlersContent);
    await fs.writeFile(factoryHmrPath, originalFactoryHmrContent);
    // Wait for HMR + re-discovery to process the restore
    await new Promise((r) => setTimeout(r, isCI ? 5000 : 2000));
  });

  test("should regenerate route types when a new route is added", async () => {
    // Read the gen file before modification
    const before = await fs.readFile(genFilePath, "utf-8");
    expect(before).not.toContain('"blog.comments"');

    // Add a new named route to blog urls
    const modified = originalBlogContent.replace(
      'path("/:postId", BlogPostHandler, { name: "post" }),',
      `path("/:postId", BlogPostHandler, { name: "post" }),
    path("/:postId/comments", BlogPostHandler, { name: "comments" }),`,
    );
    expect(modified).not.toBe(originalBlogContent);
    await fs.writeFile(blogUrlsPath, modified);

    // Wait for HMR + re-discovery + file write
    await expect(async () => {
      const after = await fs.readFile(genFilePath, "utf-8");
      expect(after).toContain('"blog.comments"');
      expect(after).toContain("/blog/:postId/comments");
    }).toPass({ timeout: WATCHER_TIMEOUT });
  });

  test("should regenerate route types when a route is removed", async () => {
    // First add the route
    const modified = originalBlogContent.replace(
      'path("/:postId", BlogPostHandler, { name: "post" }),',
      `path("/:postId", BlogPostHandler, { name: "post" }),
    path("/:postId/comments", BlogPostHandler, { name: "comments" }),`,
    );
    await fs.writeFile(blogUrlsPath, modified);

    // Wait for it to appear
    await expect(async () => {
      const content = await fs.readFile(genFilePath, "utf-8");
      expect(content).toContain('"blog.comments"');
    }).toPass({ timeout: WATCHER_TIMEOUT });

    // Now remove it by restoring original
    await fs.writeFile(blogUrlsPath, originalBlogContent);

    // Wait for it to disappear
    await expect(async () => {
      const content = await fs.readFile(genFilePath, "utf-8");
      expect(content).not.toContain('"blog.comments"');
    }).toPass({ timeout: WATCHER_TIMEOUT });
  });

  test("should not overwrite when routes have not changed", async () => {
    // Wait for gen file mtime to stabilize after the previous test's
    // afterEach restoration — the debounced re-discovery may still be
    // writing when we enter this test.
    let lastMtime = 0;
    let stableChecks = 0;
    while (stableChecks < 3) {
      const s = await fs.stat(genFilePath);
      if (s.mtimeMs === lastMtime) {
        stableChecks++;
      } else {
        stableChecks = 0;
        lastMtime = s.mtimeMs;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    // Get the initial mtime of the gen file
    const statBefore = await fs.stat(genFilePath);

    // Touch a handler file (not a URL definition file)
    const handlerContent = await fs.readFile(handlersPath, "utf-8");
    await fs.writeFile(handlersPath, handlerContent + "\n// touch");

    // Negative assertion: wait long enough for HMR + re-discovery (100ms debounce)
    // to complete, then verify the file was NOT rewritten.
    await new Promise((r) => setTimeout(r, isCI ? 4000 : 2000));

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
      '{ name: "article" }',
    );
    expect(modified).not.toBe(originalBlogContent);
    await fs.writeFile(blogUrlsPath, modified);

    await expect(async () => {
      const after = await fs.readFile(genFilePath, "utf-8");
      expect(after).not.toContain('"blog.post"');
      expect(after).toContain('"blog.article"');
    }).toPass({ timeout: WATCHER_TIMEOUT });
  });

  test("should update route types when a search schema is added", async () => {
    const before = await fs.readFile(genFilePath, "utf-8");
    // blog.post is a plain string pattern, no search schema
    expect(before).toContain('"blog.post": "/blog/:postId"');

    // Add a search schema to the post route
    const modified = originalBlogContent.replace(
      '{ name: "post" }',
      '{ name: "post", search: { tag: "string", draft: "boolean?" } }',
    );
    expect(modified).not.toBe(originalBlogContent);
    await fs.writeFile(blogUrlsPath, modified);

    await expect(async () => {
      const after = await fs.readFile(genFilePath, "utf-8");
      // Should now be an object with path and search properties
      expect(after).toContain('"blog.post"');
      expect(after).toContain('tag: "string"');
      expect(after).toContain('draft: "boolean?"');
    }).toPass({ timeout: WATCHER_TIMEOUT });
  });

  test("should update route types when a search schema is removed", async () => {
    // First add a search schema
    const withSchema = originalBlogContent.replace(
      '{ name: "post" }',
      '{ name: "post", search: { tag: "string", draft: "boolean?" } }',
    );
    await fs.writeFile(blogUrlsPath, withSchema);

    await expect(async () => {
      const content = await fs.readFile(genFilePath, "utf-8");
      expect(content).toContain('tag: "string"');
      expect(content).toContain('draft: "boolean?"');
    }).toPass({ timeout: WATCHER_TIMEOUT });

    // Remove the search schema by restoring the original
    await fs.writeFile(blogUrlsPath, originalBlogContent);

    await expect(async () => {
      const after = await fs.readFile(genFilePath, "utf-8");
      // Should revert to a plain string pattern (no search object)
      expect(after).toContain('"blog.post": "/blog/:postId"');
      expect(after).not.toContain('tag: "string"');
      expect(after).not.toContain('draft: "boolean?"');
    }).toPass({ timeout: WATCHER_TIMEOUT });
  });

  test("should update route types when an include is removed", async () => {
    const before = await fs.readFile(genFilePath, "utf-8");
    expect(before).toContain('"blog.index"');
    expect(before).toContain('"blog.post"');

    // Comment out the blog include
    const modified = originalMainUrlsContent.replace(
      'include("/blog", blogPatterns, { name: "blog" }),',
      '// include("/blog", blogPatterns, { name: "blog" }),',
    );
    expect(modified).not.toBe(originalMainUrlsContent);
    await fs.writeFile(mainUrlsPath, modified);

    await expect(async () => {
      const after = await fs.readFile(genFilePath, "utf-8");
      expect(after).not.toContain('"blog.index"');
      expect(after).not.toContain('"blog.post"');
    }).toPass({ timeout: WATCHER_TIMEOUT });
  });

  test("should update route types when an include is re-added", async () => {
    // First remove the blog include
    const removed = originalMainUrlsContent.replace(
      'include("/blog", blogPatterns, { name: "blog" }),',
      '// include("/blog", blogPatterns, { name: "blog" }),',
    );
    await fs.writeFile(mainUrlsPath, removed);

    await expect(async () => {
      const content = await fs.readFile(genFilePath, "utf-8");
      expect(content).not.toContain('"blog.index"');
    }).toPass({ timeout: WATCHER_TIMEOUT });

    // Restore the include
    await fs.writeFile(mainUrlsPath, originalMainUrlsContent);

    await expect(async () => {
      const after = await fs.readFile(genFilePath, "utf-8");
      expect(after).toContain('"blog.index"');
      expect(after).toContain('"blog.post"');
    }).toPass({ timeout: WATCHER_TIMEOUT });
  });

  // -- Runtime reverse() tests --
  // Verify that the runtime manifest used by ctx.reverse() stays in sync
  // with the gen file after HMR route changes.

  async function queryReverse(
    names: string[],
  ): Promise<Record<string, string | null>> {
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
    path("/:postId/comments", BlogPostHandler, { name: "comments" }),`,
    );
    await fs.writeFile(blogUrlsPath, modified);

    // Wait for gen file to update (confirms watcher ran)
    await expect(async () => {
      const content = await fs.readFile(genFilePath, "utf-8");
      expect(content).toContain('"blog.comments"');
    }).toPass({ timeout: WATCHER_TIMEOUT });

    // Verify reverse() now resolves the new route
    await expect(async () => {
      const after = await queryReverse(["blog.comments"]);
      expect(after["blog.comments"]).toBe("/blog/:postId/comments");
    }).toPass({ timeout: RUNTIME_TIMEOUT });
  });

  test("reverse() should not resolve a removed route", async () => {
    // First add the route
    const modified = originalBlogContent.replace(
      'path("/:postId", BlogPostHandler, { name: "post" }),',
      `path("/:postId", BlogPostHandler, { name: "post" }),
    path("/:postId/comments", BlogPostHandler, { name: "comments" }),`,
    );
    await fs.writeFile(blogUrlsPath, modified);

    await expect(async () => {
      const result = await queryReverse(["blog.comments"]);
      expect(result["blog.comments"]).toBe("/blog/:postId/comments");
    }).toPass({ timeout: WATCHER_TIMEOUT });

    // Remove the route by restoring original
    await fs.writeFile(blogUrlsPath, originalBlogContent);

    // Wait for gen file to update
    await expect(async () => {
      const content = await fs.readFile(genFilePath, "utf-8");
      expect(content).not.toContain('"blog.comments"');
    }).toPass({ timeout: WATCHER_TIMEOUT });

    // Verify reverse() no longer resolves it
    await expect(async () => {
      const after = await queryReverse(["blog.comments"]);
      expect(after["blog.comments"]).toBeNull();
    }).toPass({ timeout: RUNTIME_TIMEOUT });
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
    }).toPass({ timeout: WATCHER_TIMEOUT });

    // Runtime manifest should stay in sync with repaired file.
    await expect(async () => {
      const after = await queryReverse(["blog.index"]);
      expect(after["blog.index"]).toBe("/blog");
    }).toPass({ timeout: RUNTIME_TIMEOUT });
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
    }).toPass({ timeout: WATCHER_TIMEOUT });
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
    }).toPass({ timeout: WATCHER_TIMEOUT });

    // Verify reverse() still resolves after recreation
    await expect(async () => {
      const after = await queryReverse(["blog.index"]);
      expect(after["blog.index"]).toBe("/blog");
    }).toPass({ timeout: RUNTIME_TIMEOUT });
  });

  // -- Factory-generated route HMR tests --
  // These test routes that the static parser cannot resolve (the include()
  // second arg is a function call, classified as "factory-call"). They only
  // appear after runtime discovery via discoverRouters() + module evaluation.
  // Verifies the full watcher -> refreshRuntimeDiscovery() ->
  // discoverRouters() -> propagateDiscoveryState() pipeline.

  test("factory routes should appear in runtime manifest after discovery", async () => {
    // Factory routes (factoryHmr.alpha, factoryHmr.beta) should be in the
    // runtime manifest after initial discovery, even though the static parser
    // can't resolve them.
    await expect(async () => {
      const result = await queryReverse([
        "factoryHmr.alpha",
        "factoryHmr.beta",
      ]);
      expect(result["factoryHmr.alpha"]).toBe("/factory-hmr/alpha");
      expect(result["factoryHmr.beta"]).toBe("/factory-hmr/beta");
    }).toPass({ timeout: RUNTIME_TIMEOUT });
  });

  test("adding a factory route should update runtime manifest via re-discovery", async () => {
    // Add a new route to the factory
    const modified = originalFactoryHmrContent.replace(
      'path("/beta", BetaHandler, { name: "beta" }),',
      `path("/beta", BetaHandler, { name: "beta" }),
    path("/gamma", AlphaHandler, { name: "gamma" }),`,
    );
    expect(modified).not.toBe(originalFactoryHmrContent);
    await fs.writeFile(factoryHmrPath, modified);

    // The static parser can't see factory routes, so we skip the gen file
    // check and go straight to the runtime manifest which is updated by
    // refreshRuntimeDiscovery().
    await expect(async () => {
      const result = await queryReverse([
        "factoryHmr.alpha",
        "factoryHmr.beta",
        "factoryHmr.gamma",
      ]);
      expect(result["factoryHmr.alpha"]).toBe("/factory-hmr/alpha");
      expect(result["factoryHmr.beta"]).toBe("/factory-hmr/beta");
      expect(result["factoryHmr.gamma"]).toBe("/factory-hmr/gamma");
    }).toPass({ timeout: WATCHER_TIMEOUT });
  });

  test("removing a factory route should update runtime manifest via re-discovery", async () => {
    // Start with all three routes
    const withGamma = originalFactoryHmrContent.replace(
      'path("/beta", BetaHandler, { name: "beta" }),',
      `path("/beta", BetaHandler, { name: "beta" }),
    path("/gamma", AlphaHandler, { name: "gamma" }),`,
    );
    await fs.writeFile(factoryHmrPath, withGamma);

    await expect(async () => {
      const result = await queryReverse(["factoryHmr.gamma"]);
      expect(result["factoryHmr.gamma"]).toBe("/factory-hmr/gamma");
    }).toPass({ timeout: WATCHER_TIMEOUT });

    // Remove gamma by restoring original
    await fs.writeFile(factoryHmrPath, originalFactoryHmrContent);

    // Verify gamma is purged from the runtime manifest.
    // This exercises: clearAllRouterData() in propagateDiscoveryState()
    // and the full re-import pipeline that re-evaluates the factory module.
    await expect(async () => {
      const result = await queryReverse([
        "factoryHmr.alpha",
        "factoryHmr.beta",
        "factoryHmr.gamma",
      ]);
      expect(result["factoryHmr.alpha"]).toBe("/factory-hmr/alpha");
      expect(result["factoryHmr.beta"]).toBe("/factory-hmr/beta");
      expect(result["factoryHmr.gamma"]).toBeNull();
    }).toPass({ timeout: WATCHER_TIMEOUT });
  });
});
