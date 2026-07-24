import { expect, test, type APIRequestContext } from "@playwright/test";
import { useFixture } from "./fixture";
import { writeFileBumpMtime } from "./helper";
import path from "node:path";
import { execSync } from "node:child_process";

/**
 * Dev HMR for clientUrls() modules: editing a route pattern in a "use client"
 * clientUrls module must re-run discovery and refresh the SERVING router's
 * materialized client mount.
 *
 * Scar (2026-07-24): three stacked plugin gaps left the old pattern serving
 * 200 and the new one 404ing until a full restart — the watcher sniff bailed
 * on "use client" files (and the code scan rejects `urls(` inside
 * `clientUrls(` as a sub-identifier), projections refreshed only AFTER the
 * discovery entry import, and the routes-manifest virtual module replayed
 * stale projection literals on rsc program reloads, clobbering the registry
 * as the realm's last write. Pinned by the watcher carve-out + importer-chain
 * invalidation in router-discovery.ts and
 * refreshRecordedClientUrlProjections in client-urls-projection.ts.
 *
 * Serial + isolated server: mutates a shared source file.
 */

const isCI = !!process.env.CI;
const WATCHER_TIMEOUT = isCI ? 30_000 : 15_000;

// Skip on CI: the file watcher is unreliable on GitHub Actions runners when
// multiple Vite dev servers watch the same directory (shared webServer +
// isolated test server). Run locally before PRs that touch the Vite plugin
// watcher or client-urls discovery.
test.describe.serial("client-urls-hmr", () => {
  test.skip(isCI, "file watcher unreliable on CI — run locally");

  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });

  test.setTimeout(isCI ? 90_000 : 60_000);

  const clientUrlsPath = path.resolve(
    "./e2e/test-app/src/urls/client-urls.tsx",
  );
  let originalContent = "";
  let dirtyGuardMessage = "";

  test.beforeAll(() => {
    // Bail if the developer has local edits (worktree differs from index)
    // rather than overwriting them.
    try {
      const dirty = execSync(`git diff --name-only -- "${clientUrlsPath}"`, {
        encoding: "utf-8",
      }).trim();
      if (dirty) {
        dirtyGuardMessage =
          `${clientUrlsPath} has uncommitted changes. ` +
          `Restore it first: git restore --worktree ${dirty}`;
        return;
      }
    } catch {
      // Not a git repo or git unavailable — proceed with the worktree file.
    }

    // Baseline from the INDEX (`git show :path`), not HEAD: it recovers from
    // a crashed prior run's leftover edits, and it works while the clientUrls
    // fixture is staged but not yet committed (HEAD would not have it).
    try {
      const repoRoot = execSync("git rev-parse --show-toplevel", {
        encoding: "utf-8",
      }).trim();
      const rel = path.relative(repoRoot, clientUrlsPath).replaceAll("\\", "/");
      originalContent = execSync(`git show :${rel}`, {
        encoding: "utf-8",
        cwd: repoRoot,
      });
    } catch {
      dirtyGuardMessage = `Could not read the index baseline for ${clientUrlsPath}`;
    }
  });

  // Deferred skip: test.skip() cannot be called from beforeAll.
  test.beforeEach(() => {
    test.skip(dirtyGuardMessage.length > 0, dirtyGuardMessage);
  });

  test.afterAll(() => {
    if (originalContent) writeFileBumpMtime(clientUrlsPath, originalContent);
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

  test("route-shape edit refreshes serving patterns and restore heals", async ({
    request,
  }) => {
    const oldPattern = 'path("/client-urls-e2e/items/:itemId", ClientUrlsItem';
    const newPattern =
      'path("/client-urls-e2e/entries/:itemId", ClientUrlsItem';
    expect(originalContent).toContain(oldPattern);

    // Baseline: the committed pattern serves, the edited one does not.
    await expect
      .poll(() => status(request, "/client-urls-e2e/items/hmr"), {
        timeout: WATCHER_TIMEOUT,
      })
      .toBe(200);
    expect(await status(request, "/client-urls-e2e/entries/hmr")).toBe(404);

    // Edit the route pattern inside the "use client" clientUrls module.
    writeFileBumpMtime(
      clientUrlsPath,
      originalContent.replace(oldPattern, newPattern),
    );
    await expect
      .poll(() => status(request, "/client-urls-e2e/entries/hmr"), {
        timeout: WATCHER_TIMEOUT,
      })
      .toBe(200);
    await expect
      .poll(() => status(request, "/client-urls-e2e/items/hmr"), {
        timeout: WATCHER_TIMEOUT,
      })
      .toBe(404);

    // Restore: a second HMR cycle converges back to the baseline.
    writeFileBumpMtime(clientUrlsPath, originalContent);
    await expect
      .poll(() => status(request, "/client-urls-e2e/items/hmr"), {
        timeout: WATCHER_TIMEOUT,
      })
      .toBe(200);
    await expect
      .poll(() => status(request, "/client-urls-e2e/entries/hmr"), {
        timeout: WATCHER_TIMEOUT,
      })
      .toBe(404);
  });
});
