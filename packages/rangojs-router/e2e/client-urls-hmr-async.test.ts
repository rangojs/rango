import { expect, test, type APIRequestContext } from "@playwright/test";
import { useFixture } from "./fixture";
import { writeFileBumpMtime } from "./helper";
import path from "node:path";
import { execSync } from "node:child_process";

/**
 * Dev HMR for a clientUrls() module mounted DIRECTLY through an async
 * include (`include(prefix, () => import("./x.client"))`, no server wrapper):
 * adding and removing a route in the "use client" module must refresh the
 * serving router's materialized mount, exactly as for the eager mount pinned
 * by client-urls-hmr.test.ts. The async path caches the resolved provider on
 * the lazy entry; re-discovery must rebuild that entry from the fresh
 * projection rather than serve the stale expansion.
 *
 * Own file (not a second test in client-urls-hmr.test.ts): each HMR scenario
 * gets its own isolated dev server lifecycle.
 */

const isCI = !!process.env.CI;
const WATCHER_TIMEOUT = isCI ? 30_000 : 15_000;

test.describe.serial("client-urls-hmr-async", () => {
  test.skip(isCI, "file watcher unreliable on CI — run locally");

  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });

  test.setTimeout(isCI ? 90_000 : 60_000);

  const modulePath = path.resolve(
    "./e2e/test-app/src/urls/client-urls-async-direct.tsx",
  );
  let originalContent = "";
  let dirtyGuardMessage = "";

  test.beforeAll(() => {
    try {
      const dirty = execSync(`git diff --name-only -- "${modulePath}"`, {
        encoding: "utf-8",
      }).trim();
      if (dirty) {
        dirtyGuardMessage =
          `${modulePath} has uncommitted changes. ` +
          `Restore it first: git restore --worktree ${dirty}`;
        return;
      }
    } catch {
      // Not a git repo or git unavailable — proceed with the worktree file.
    }

    // Baseline from the INDEX (see client-urls-hmr.test.ts for why).
    try {
      const repoRoot = execSync("git rev-parse --show-toplevel", {
        encoding: "utf-8",
      }).trim();
      const rel = path.relative(repoRoot, modulePath).replaceAll("\\", "/");
      originalContent = execSync(`git show :${rel}`, {
        encoding: "utf-8",
        cwd: repoRoot,
      });
    } catch {
      dirtyGuardMessage = `Could not read the index baseline for ${modulePath}`;
    }
  });

  test.beforeEach(() => {
    test.skip(dirtyGuardMessage.length > 0, dirtyGuardMessage);
  });

  test.afterAll(() => {
    if (originalContent) writeFileBumpMtime(modulePath, originalContent);
  });

  async function status(
    request: APIRequestContext,
    pathname: string,
  ): Promise<number> {
    const response = await request.get(f.url(pathname), {
      headers: { accept: "text/html" },
    });
    return response.status();
  }

  test("adding and removing a route in the async-mounted module refreshes serving patterns", async ({
    request,
  }) => {
    const itemRoute =
      '  path("/items/:itemId", AsyncDirectItem, { name: "item" }),\n';
    const extraRoute =
      '  path("/extra", AsyncDirectIndex, { name: "extra" }),\n';
    expect(originalContent).toContain(itemRoute);

    // Baseline: the committed routes serve; the not-yet-added one does not.
    await expect
      .poll(() => status(request, "/client-urls-async-direct/items/hmr"), {
        timeout: WATCHER_TIMEOUT,
      })
      .toBe(200);
    expect(await status(request, "/client-urls-async-direct/extra")).toBe(404);

    // Add a route.
    writeFileBumpMtime(
      modulePath,
      originalContent.replace(itemRoute, itemRoute + extraRoute),
    );
    await expect
      .poll(() => status(request, "/client-urls-async-direct/extra"), {
        timeout: WATCHER_TIMEOUT,
      })
      .toBe(200);
    expect(await status(request, "/client-urls-async-direct/items/hmr")).toBe(
      200,
    );

    // Remove a route (the added one is gone too: this edit starts from the
    // baseline).
    writeFileBumpMtime(modulePath, originalContent.replace(itemRoute, ""));
    await expect
      .poll(() => status(request, "/client-urls-async-direct/items/hmr"), {
        timeout: WATCHER_TIMEOUT,
      })
      .toBe(404);
    expect(await status(request, "/client-urls-async-direct/extra")).toBe(404);
    expect(await status(request, "/client-urls-async-direct")).toBe(200);

    // Restore: converges back to the baseline.
    writeFileBumpMtime(modulePath, originalContent);
    await expect
      .poll(() => status(request, "/client-urls-async-direct/items/hmr"), {
        timeout: WATCHER_TIMEOUT,
      })
      .toBe(200);
  });
});
