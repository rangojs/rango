import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  ROUTE_REDISCOVERY_PATTERN,
  waitForHydration,
  writeFileAndAwaitHmr,
  writeFileBumpMtime,
} from "./helper";
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
 * 8. Rapid sequential edits converge to the final state (no stale intermediate)
 *
 * These tests must run serially since they modify shared source files.
 * Route-definition mutations are written via writeFileBumpMtime (shared
 * @shared/e2e helper): a write plus a strictly monotonic mtime, so a watcher
 * running alongside the shared dev server cannot coalesce or drop the change
 * event.
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
    // The Vite error overlay (off on the shared server) for the invalid
    // transition({ when }) test below.
    cliOptions: { env: { RANGO_E2E_HMR_OVERLAY: "1" } },
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
  let originalGenContent: string;
  let dirtyGuardMessage = "";

  test.beforeAll(async () => {
    // Check for uncommitted changes BEFORE touching files. If a developer
    // has local edits in the target files, bail out rather than overwriting.
    try {
      const dirty = execSync(
        `git diff --name-only -- "${blogUrlsPath}" "${mainUrlsPath}" "${handlersPath}" "${factoryHmrPath}" "${genFilePath}"`,
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
      // Read from the INDEX (`git show :path`), not HEAD: staged-but-uncommitted
      // fixture edits are legitimate baselines during feature work, and a HEAD
      // read silently REVERTS them in afterAll (scar: this clobbered the
      // clientUrls include out of urls.tsx right before a commit, shipping a
      // fixture without its mount). The index still recovers from a crashed
      // prior run's worktree edits, which is what the git read is for.
      return execSync(`git show :${rel}`, { encoding: "utf-8", cwd: repoRoot });
    }

    originalBlogContent = gitBaseline(blogUrlsPath);
    originalMainUrlsContent = gitBaseline(mainUrlsPath);
    originalHandlersContent = gitBaseline(handlersPath);
    originalFactoryHmrContent = gitBaseline(factoryHmrPath);
    originalGenContent = gitBaseline(genFilePath);

    // The dirty guard above guarantees source files match HEAD. Do not rewrite
    // clean baselines here: those no-op writes start rediscovery immediately
    // before the first test and race its first real mutation.
    await expect
      .poll(() => ROUTE_REDISCOVERY_PATTERN.test(f.proc().stdout()), {
        timeout: WATCHER_TIMEOUT,
      })
      .toBe(true);
    await expect(expectBaselineApplied).toPass({ timeout: WATCHER_TIMEOUT });
  });

  // Deferred skip: test.skip() cannot be called from beforeAll, so we
  // check the guard flag here and skip each test individually.
  test.beforeEach(() => {
    test.skip(dirtyGuardMessage.length > 0, dirtyGuardMessage);
  });

  async function expectBaselineApplied(): Promise<void> {
    expect(await fs.readFile(genFilePath, "utf-8")).toBe(originalGenContent);
    const reverse = await queryReverse([
      "blog.index",
      "blog.post",
      "blog.comments",
      "blog.article",
      "blog.recovered",
    ]);
    expect(reverse["blog.index"]).toBe("/blog");
    expect(reverse["blog.post"]).toBe("/blog/:postId");
    expect(reverse["blog.comments"]).toBeNull();
    expect(reverse["blog.article"]).toBeNull();
    expect(reverse["blog.recovered"]).toBeNull();
  }

  async function writeRouteFileAndAwait(
    page: import("@playwright/test").Page,
    filePath: string,
    content: string,
    waitForApplied: () => Promise<void>,
  ): Promise<void> {
    await writeFileAndAwaitHmr(page, filePath, content, {
      totalTimeoutMs: WATCHER_TIMEOUT,
      retryIntervalMs: 2_000,
      waitForApplied,
    });
  }

  // Write every baseline before waiting: with discovery in its failed state
  // no wait succeeds until the file that broke it is back, and a per-file
  // write-then-wait left the later files modified (issue #1040).
  test.afterEach(async () => {
    if (dirtyGuardMessage) return;
    const baselines = [
      [blogUrlsPath, originalBlogContent],
      [mainUrlsPath, originalMainUrlsContent],
      [handlersPath, originalHandlersContent],
      [factoryHmrPath, originalFactoryHmrContent],
    ] as const;
    const restoreAll = async (force: boolean): Promise<void> => {
      for (const [filePath, baseline] of baselines) {
        if (!force && (await fs.readFile(filePath, "utf-8")) === baseline) {
          continue;
        }
        writeFileBumpMtime(filePath, baseline);
      }
    };
    await restoreAll(false);
    try {
      await expect(expectBaselineApplied).toPass({ timeout: WATCHER_TIMEOUT });
    } catch {
      // The watcher may have missed the event; rewrite once and wait again.
      await restoreAll(true);
      await expect(expectBaselineApplied).toPass({ timeout: WATCHER_TIMEOUT });
    }
    await waitForRuntimeSettled();
  });

  // A gen-file write (the recreate/tamper tests) reloads the dev server's rsc
  // graph after the test's own assertion passed, and the next test's first
  // runtime query then gets an HTML error page. Consecutive good answers, not
  // a fixed sleep.
  async function waitForRuntimeSettled(): Promise<void> {
    const deadline = Date.now() + WATCHER_TIMEOUT;
    let consecutive = 0;
    while (consecutive < 5) {
      try {
        const reverse = await queryReverse(["blog.index"]);
        consecutive = reverse["blog.index"] === "/blog" ? consecutive + 1 : 0;
      } catch {
        consecutive = 0;
      }
      if (Date.now() > deadline) {
        throw new Error("dev server did not settle after baseline restore");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  // Force-restore the gen file when the test suite exits, even if
  // afterEach couldn't wait long enough for the watcher to regenerate.
  // Prevents the dirty gen file from failing typecheck in subsequent runs.
  test.afterAll(async () => {
    if (dirtyGuardMessage || !originalGenContent) return;
    await fs.writeFile(genFilePath, originalGenContent);
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
    writeFileBumpMtime(blogUrlsPath, modified);

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
    writeFileBumpMtime(blogUrlsPath, modified);

    // Wait for it to appear
    await expect(async () => {
      const content = await fs.readFile(genFilePath, "utf-8");
      expect(content).toContain('"blog.comments"');
    }).toPass({ timeout: WATCHER_TIMEOUT });

    // Now remove it by restoring original
    writeFileBumpMtime(blogUrlsPath, originalBlogContent);

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
    expect(before).toContain('"factoryHmr.alpha"');
    expect(before).not.toContain('"factoryHmr.article"');

    // Rename a route that is not required to evaluate the app entry.
    const modified = originalFactoryHmrContent.replace(
      '{ name: "alpha" }',
      '{ name: "article" }',
    );
    expect(modified).not.toBe(originalFactoryHmrContent);
    writeFileBumpMtime(factoryHmrPath, modified);

    await expect(async () => {
      const after = await fs.readFile(genFilePath, "utf-8");
      expect(after).not.toContain('"factoryHmr.alpha"');
      expect(after).toContain('"factoryHmr.article"');
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
    writeFileBumpMtime(blogUrlsPath, modified);

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
    writeFileBumpMtime(blogUrlsPath, withSchema);

    await expect(async () => {
      const content = await fs.readFile(genFilePath, "utf-8");
      expect(content).toContain('tag: "string"');
      expect(content).toContain('draft: "boolean?"');
    }).toPass({ timeout: WATCHER_TIMEOUT });

    // Remove the search schema by restoring the original
    writeFileBumpMtime(blogUrlsPath, originalBlogContent);

    await expect(async () => {
      const after = await fs.readFile(genFilePath, "utf-8");
      // Should revert to a plain string pattern (no search object)
      expect(after).toContain('"blog.post": "/blog/:postId"');
      expect(after).not.toContain('tag: "string"');
      expect(after).not.toContain('draft: "boolean?"');
    }).toPass({ timeout: WATCHER_TIMEOUT });
  });

  test("should update route types when an include is removed", async ({
    page,
  }) => {
    const before = await fs.readFile(genFilePath, "utf-8");
    expect(before).toContain('"metaTemplate.index"');
    expect(before).toContain('"metaTemplate.child"');

    // Comment out an include that is not required to evaluate the app entry.
    const modified = originalMainUrlsContent.replace(
      'include("/meta-template", metaTemplatePatterns, { name: "metaTemplate" }),',
      '// include("/meta-template", metaTemplatePatterns, { name: "metaTemplate" }),',
    );
    expect(modified).not.toBe(originalMainUrlsContent);
    await writeRouteFileAndAwait(page, mainUrlsPath, modified, async () => {
      const after = await fs.readFile(genFilePath, "utf-8");
      expect(after).not.toContain('"metaTemplate.index"');
      expect(after).not.toContain('"metaTemplate.child"');
      const reverse = await queryReverse([
        "metaTemplate.index",
        "metaTemplate.child",
      ]);
      expect(reverse["metaTemplate.index"]).toBeNull();
      expect(reverse["metaTemplate.child"]).toBeNull();
    });
  });

  test("should update route types when an include is re-added", async ({
    page,
  }) => {
    // First remove an include that is not required to evaluate the app entry.
    const removed = originalMainUrlsContent.replace(
      'include("/meta-template", metaTemplatePatterns, { name: "metaTemplate" }),',
      '// include("/meta-template", metaTemplatePatterns, { name: "metaTemplate" }),',
    );
    await writeRouteFileAndAwait(page, mainUrlsPath, removed, async () => {
      const content = await fs.readFile(genFilePath, "utf-8");
      expect(content).not.toContain('"metaTemplate.index"');
      const reverse = await queryReverse(["metaTemplate.index"]);
      expect(reverse["metaTemplate.index"]).toBeNull();
    });

    // Restore the include
    await writeRouteFileAndAwait(
      page,
      mainUrlsPath,
      originalMainUrlsContent,
      async () => {
        const after = await fs.readFile(genFilePath, "utf-8");
        expect(after).toContain('"metaTemplate.index"');
        expect(after).toContain('"metaTemplate.child"');
        const reverse = await queryReverse([
          "metaTemplate.index",
          "metaTemplate.child",
        ]);
        expect(reverse["metaTemplate.index"]).toBe("/meta-template");
        expect(reverse["metaTemplate.child"]).toBe("/meta-template/child");
      },
    );
  });

  test("should converge to the final state after rapid sequential edits", async () => {
    // Three rapid writes to the same route file, each adding a differently
    // named route. writeFileBumpMtime forces a monotonic mtime per write so the
    // watcher cannot silently coalesce them into a stale intermediate; the gen
    // file and runtime manifest must reflect only the LAST write.
    const mkVariant = (suffix: string, name: string) =>
      originalBlogContent.replace(
        'path("/:postId", BlogPostHandler, { name: "post" }),',
        `path("/:postId", BlogPostHandler, { name: "post" }),
    path("/:postId/${suffix}", BlogPostHandler, { name: "${name}" }),`,
      );
    writeFileBumpMtime(blogUrlsPath, mkVariant("b1", "burstA"));
    writeFileBumpMtime(blogUrlsPath, mkVariant("b2", "burstB"));
    writeFileBumpMtime(blogUrlsPath, mkVariant("b3", "burstC"));

    // Gen file converges to the final write only.
    await expect(async () => {
      const gen = await fs.readFile(genFilePath, "utf-8");
      expect(gen).toContain('"blog.burstC"');
      expect(gen).toContain("/blog/:postId/b3");
      expect(gen).not.toContain('"blog.burstA"');
      expect(gen).not.toContain('"blog.burstB"');
    }).toPass({ timeout: WATCHER_TIMEOUT });

    // Runtime manifest converges to the same final state.
    await expect(async () => {
      const result = await queryReverse([
        "blog.burstA",
        "blog.burstB",
        "blog.burstC",
      ]);
      expect(result["blog.burstC"]).toBe("/blog/:postId/b3");
      expect(result["blog.burstA"]).toBeNull();
      expect(result["blog.burstB"]).toBeNull();
    }).toPass({ timeout: RUNTIME_TIMEOUT });
  });

  // -- Runtime reverse() tests --
  // Verify that the runtime manifest used by ctx.reverse() stays in sync
  // with the gen file after HMR route changes.

  async function queryReverse(
    names: string[],
  ): Promise<Record<string, string | null>> {
    const params = names.map((n) => `name=${encodeURIComponent(n)}`).join("&");
    const res = await fetch(f.url(`/__debug/reverse-test?${params}`));
    const body = await res.json();
    return body;
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
    writeFileBumpMtime(blogUrlsPath, modified);

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
    writeFileBumpMtime(blogUrlsPath, modified);

    await expect(async () => {
      const result = await queryReverse(["blog.comments"]);
      expect(result["blog.comments"]).toBe("/blog/:postId/comments");
    }).toPass({ timeout: WATCHER_TIMEOUT });

    // Remove the route by restoring original
    writeFileBumpMtime(blogUrlsPath, originalBlogContent);

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
    writeFileBumpMtime(factoryHmrPath, modified);

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
    writeFileBumpMtime(factoryHmrPath, withGamma);

    await expect(async () => {
      const result = await queryReverse(["factoryHmr.gamma"]);
      expect(result["factoryHmr.gamma"]).toBe("/factory-hmr/gamma");
    }).toPass({ timeout: WATCHER_TIMEOUT });

    // Remove gamma by restoring original
    writeFileBumpMtime(factoryHmrPath, originalFactoryHmrContent);

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

  // -- Invalid transition({ when }) --
  // `when` runs in the browser: a server function in urls() (here a
  // server-module export passed by name; an inline literal would be hoisted
  // into a client module) fails re-discovery. The error must be LOUD on an
  // HMR edit too: the terminal prints it (an error, not the recovery-mode
  // warning) and the browser shows it in the Vite error overlay, instead of
  // the last-good route tree serving silently.
  test("an invalid transition({ when }) edit prints the error and shows the Vite overlay", async ({
    page,
  }) => {
    test.skip(
      !f.proc(),
      "isolatedServer required to observe dev-server output",
    );
    const proc = f.proc()!;
    const ERROR =
      'transition({ when }) on route "blog.post" (/blog/:postId) is not a client function.';

    await page.goto(f.url("/blog"));
    await expect(
      page.locator("vite-error-overlay", {
        hasText: "is not a client function",
      }),
    ).toHaveCount(0);
    const stdoutAtStart = proc.stdout().length;
    const stderrAtStart = proc.stderr().length;

    const broken = originalBlogContent
      .replace("({ path, cache })", "({ path, cache, transition })")
      .replace(
        'path("/:postId", BlogPostHandler, { name: "post" }),',
        `path("/:postId", BlogPostHandler, { name: "post" }, () => [
      transition({ when: BlogIndexHandler as never }),
    ]),`,
      );
    expect(broken).not.toBe(originalBlogContent);
    writeFileBumpMtime(blogUrlsPath, broken);

    await expect(async () => {
      const fresh =
        proc.stdout().slice(stdoutAtStart) + proc.stderr().slice(stderrAtStart);
      expect(fresh).toContain(ERROR);
    }).toPass({ timeout: WATCHER_TIMEOUT });
    await expect(page.locator("vite-error-overlay")).toContainText(
      "is not a client function",
      { timeout: WATCHER_TIMEOUT },
    );
    // It stays up: a reload re-sends it.
    await page.reload();
    await expect(page.locator("vite-error-overlay")).toContainText(
      "is not a client function",
      { timeout: WATCHER_TIMEOUT },
    );
    // The gen file stays at last-good while the definition is invalid.
    expect(await fs.readFile(genFilePath, "utf-8")).toBe(originalGenContent);
  });

  // -- Inline transition({ when }) (the build hoists the literal into a
  // "use client" module) --
  const withInlineWhen = (predicate: string, prelude = ""): string =>
    originalBlogContent
      .replace("({ path, cache })", "({ path, cache, transition })")
      .replace(
        "export const blogPatterns",
        `${prelude}export const blogPatterns`,
      )
      .replace(
        'path("/:postId", BlogPostHandler, { name: "post" }),',
        `path("/:postId", BlogPostHandler, { name: "post" }, () => [
      transition({ when: ${predicate} }),
    ]),`,
      );

  test("an inline transition({ when }) edit republishes the hoisted predicate", async ({
    page,
  }) => {
    const markingWhen = (mark: string) =>
      withInlineWhen(`() => {
        (window as unknown as { __hoistMark?: string }).__hoistMark = "${mark}";
        return true;
      }`);
    const readMark = async (): Promise<string | undefined> => {
      await page.goto(f.url("/blog"));
      await waitForHydration(page);
      await page.getByTestId("blog-post-link-1").click();
      await expect(page).toHaveURL(/\/blog\/post-1$/);
      return page.evaluate(
        () => (window as unknown as { __hoistMark?: string }).__hoistMark,
      );
    };

    // Written like the suite's other route edits: re-touched between
    // attempts until the browser runs the new predicate (a single write and
    // a 10s poll flaked right after the previous test's restore cycle).
    for (const mark of ["v1", "v2"]) {
      await writeRouteFileAndAwait(
        page,
        blogUrlsPath,
        markingWhen(mark),
        async () => {
          expect(await readMark()).toBe(mark);
        },
      );
    }
  });

  test("an inline transition({ when }) that captures a server binding prints the error and shows the Vite overlay", async ({
    page,
  }) => {
    test.skip(
      !f.proc(),
      "isolatedServer required to observe dev-server output",
    );
    const proc = f.proc()!;
    const ERROR = "`limit` is a server-module binding.";

    await page.goto(f.url("/blog"));
    const stdoutAtStart = proc.stdout().length;
    const stderrAtStart = proc.stderr().length;
    writeFileBumpMtime(
      blogUrlsPath,
      withInlineWhen("() => limit > 1", "const limit = 3;\n\n"),
    );

    await expect(async () => {
      const fresh =
        proc.stdout().slice(stdoutAtStart) + proc.stderr().slice(stderrAtStart);
      expect(fresh).toContain(ERROR);
    }).toPass({ timeout: WATCHER_TIMEOUT });
    await expect(page.locator("vite-error-overlay")).toContainText(ERROR, {
      timeout: WATCHER_TIMEOUT,
    });
  });

  // -- Recovery mode test --
  // Models the user-reported "stuck after recovery" pattern:
  //   1. A route-file edit triggers HMR re-discovery.
  //   2. Discovery throws because a non-route file in the import chain
  //      (here: blog.handlers.tsx) has a syntax error.
  //   3. The user fixes the non-route file. Without recovery mode, the
  //      watcher silently skips this change (no urls()/createRouter
  //      content match) and the manifest stays frozen at last-good.
  //   4. With recovery mode, the watcher treats any in-scan source
  //      change as a candidate while lastDiscoveryError is set, so the
  //      handlers fix triggers rediscovery and the manifest unsticks.

  test("recovery: helper-file fix after broken-import error re-runs discovery", async () => {
    // Without isolatedServer this test cannot observe the dev server's
    // stderr, so the wait-for-failure step below would silently degrade
    // into a fixed sleep. Skip in that case rather than passing falsely.
    test.skip(
      !f.proc(),
      "isolatedServer required to observe dev-server stderr for the failed-rediscovery marker",
    );

    // Sanity: the new route doesn't exist yet.
    const before = await fs.readFile(genFilePath, "utf-8");
    expect(before).not.toContain('"blog.recovered"');

    // Snapshot stderr length so the wait below only matches a NEW
    // failure produced by this test's writes, not a pre-existing one
    // from earlier serial tests.
    const proc = f.proc()!;
    const stderrAtStart = proc.stderr().length;
    const FAILURE_MARKER = "Runtime re-discovery failed";

    // 1. Break blog.handlers.tsx first. It has no urls()/createRouter, so
    //    outside recovery mode the watcher ignores it and no rediscovery
    //    starts yet. Then add the route: the rediscovery that edit triggers
    //    can only see the broken helper, so reaching the failed state does
    //    not depend on both writes landing in one debounce window.
    const modifiedBlogUrls = originalBlogContent.replace(
      'path("/:postId", BlogPostHandler, { name: "post" }),',
      `path("/:postId", BlogPostHandler, { name: "post" }),
    path("/recovered", BlogPostHandler, { name: "recovered" }),`,
    );
    const brokenHandlers =
      originalHandlersContent + "\n\n// recovery-test syntax error\n}}}}\n";
    expect(modifiedBlogUrls).not.toBe(originalBlogContent);
    writeFileBumpMtime(handlersPath, brokenHandlers);
    writeFileBumpMtime(blogUrlsPath, modifiedBlogUrls);

    // 2. Wait until the dev server logs the rediscovery failure. Polling
    //    on this marker (instead of a fixed sleep) ensures the test only
    //    proceeds once recovery mode is actually entered — otherwise
    //    a slow watcher could let the handlers fix in step 3 race ahead
    //    and the test would pass via a normal (non-recovery) rediscovery.
    await expect(async () => {
      const fresh = proc.stderr().slice(stderrAtStart);
      expect(fresh).toContain(FAILURE_MARKER);
    }).toPass({ timeout: WATCHER_TIMEOUT });

    // The runtime must not resolve the route yet (an erroring query counts:
    // the router cannot be evaluated while the helper is broken). The
    // generated file cannot carry this check: the watcher writes it from a
    // static parse of blog.tsx before the runtime rediscovery fails, and only
    // a second change event takes it back to last-good, so it holds the new
    // route in some runs and not in others.
    const duringFailure = await queryReverse(["blog.recovered"]).catch(
      () => null,
    );
    expect(duringFailure?.["blog.recovered"] ?? null).not.toBe(
      "/blog/recovered",
    );

    // 3. Fix blog.handlers.tsx WITHOUT re-touching blog.tsx. The
    //    handlers file has no urls()/createRouter, so the pre-fix
    //    watcher would skip it. Recovery mode must trigger
    //    rediscovery anyway because lastDiscoveryError is set.
    writeFileBumpMtime(handlersPath, originalHandlersContent);

    // 4. Recovery rediscovery succeeds. The generated file may hold the
    //    route already (see above); the runtime manifest below is the proof.
    await expect(async () => {
      const gen = await fs.readFile(genFilePath, "utf-8");
      expect(gen).toContain('"blog.recovered"');
      expect(gen).toContain("/blog/recovered");
    }).toPass({ timeout: WATCHER_TIMEOUT });

    // Runtime manifest stays in sync after recovery.
    await expect(async () => {
      const result = await queryReverse(["blog.recovered"]);
      expect(result["blog.recovered"]).toBe("/blog/recovered");
    }).toPass({ timeout: RUNTIME_TIMEOUT });
  });
});
