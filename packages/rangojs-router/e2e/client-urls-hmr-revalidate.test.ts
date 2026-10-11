import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  getNumericContent,
  testId,
  waitForHydration,
  writeFileBumpMtime,
} from "./helper";
import path from "node:path";
import { execSync } from "node:child_process";

/**
 * Dev HMR for a clientUrls() loader's revalidate(): the build moves the
 * predicate to a server module (`<file>?rango-revalidate`) under a key that
 * hashes its source, so an edit of its body changes the key. The next action
 * must run the edited predicate without a restart: discovery refreshes the
 * projection to the new key, and the RSC realm registers the edited module.
 *
 * Serial + isolated server: mutates a shared source file.
 */

const isCI = !!process.env.CI;
const WATCHER_TIMEOUT = isCI ? 30_000 : 20_000;

test.describe.serial("client-urls-hmr-revalidate", () => {
  test.skip(isCI, "file watcher unreliable on CI — run locally");

  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });

  test.setTimeout(isCI ? 120_000 : 90_000);

  const fixturePath = path.resolve(
    "./e2e/test-app/src/urls/client-urls-action.tsx",
  );
  const before = "actionResult?.ok === true";
  const after = "actionResult?.ok === false";
  let originalContent = "";
  let dirtyGuardMessage = "";

  test.beforeAll(() => {
    try {
      const dirty = execSync(`git diff --name-only -- "${fixturePath}"`, {
        encoding: "utf-8",
      }).trim();
      if (dirty) {
        dirtyGuardMessage =
          `${fixturePath} has uncommitted changes. ` +
          `Restore it first: git restore --worktree ${dirty}`;
        return;
      }
    } catch {
      // Not a git repo or git unavailable — proceed with the worktree file.
    }
    try {
      const repoRoot = execSync("git rev-parse --show-toplevel", {
        encoding: "utf-8",
      }).trim();
      const rel = path.relative(repoRoot, fixturePath).replaceAll("\\", "/");
      originalContent = execSync(`git show :${rel}`, {
        encoding: "utf-8",
        cwd: repoRoot,
      });
    } catch {
      dirtyGuardMessage = `Could not read the index baseline for ${fixturePath}`;
    }
  });

  test.beforeEach(() => {
    test.skip(dirtyGuardMessage.length > 0, dirtyGuardMessage);
  });

  test.afterAll(() => {
    if (originalContent) writeFileBumpMtime(fixturePath, originalContent);
  });

  /**
   * On a fresh /client-urls-action page, click `button`; once the action
   * committed, did the result loader re-run? "unsettled" when the action did
   * not commit (a cold dev server re-optimizing deps reloads the page).
   */
  async function decide(
    page: Page,
    button: "ca-result-ok" | "ca-result-fail",
  ): Promise<"reran" | "held" | "unsettled"> {
    await page.goto(f.url("/client-urls-action"));
    await waitForHydration(page);
    const readCount = async (): Promise<number> =>
      Number(
        (await testId(page, "ca-loader").textContent())?.replace("count:", ""),
      );
    const runs = await getNumericContent(testId(page, "ca-result-runs"));
    const count = await readCount();
    await testId(page, button).click();
    try {
      await expect.poll(readCount, { timeout: 5_000 }).toBe(count + 1);
    } catch {
      return "unsettled";
    }
    return (await getNumericContent(testId(page, "ca-result-runs"))) > runs
      ? "reran"
      : "held";
  }

  test("editing a revalidate() body changes the next action's decision without a restart", async ({
    page,
  }) => {
    expect(originalContent).toContain(before);
    await expect
      .poll(() => decide(page, "ca-result-ok"), { timeout: WATCHER_TIMEOUT })
      .toBe("reran");
    expect(await decide(page, "ca-result-fail")).toBe("held");

    // Invert the predicate: re-run after a failure, hold after a success.
    writeFileBumpMtime(fixturePath, originalContent.replace(before, after));
    await expect
      .poll(() => decide(page, "ca-result-ok"), { timeout: WATCHER_TIMEOUT })
      .toBe("held");
    expect(await decide(page, "ca-result-fail")).toBe("reran");

    // Restore: the original decision is back.
    writeFileBumpMtime(fixturePath, originalContent);
    await expect
      .poll(() => decide(page, "ca-result-ok"), { timeout: WATCHER_TIMEOUT })
      .toBe("reran");
  });
});
