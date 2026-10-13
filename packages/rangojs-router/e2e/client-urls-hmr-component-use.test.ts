import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  captureHmrEvents,
  ROUTE_REDISCOVERY_PATTERN,
  testId,
  waitForHydration,
  writeFileBumpMtime,
} from "./helper";
import path from "node:path";
import { execSync } from "node:child_process";

/**
 * Dev HMR for a clientUrls() component's own items (`Component.use`) in a
 * module apart from the group: the dev watcher treats an edit of such a
 * module like a group edit, so discovery refreshes the group's projection
 * and the RSC realm registers the edited predicate under its new key. The
 * next action must run the edited predicate without a restart. In the
 * browser, the component module is a Fast Refresh boundary: a `.use` edit
 * must also update the group, whose records the browser navigates with,
 * while a markup edit stays a Fast Refresh.
 *
 * Serial + isolated server: mutates a shared source file.
 */

const isCI = !!process.env.CI;
const WATCHER_TIMEOUT = isCI ? 30_000 : 20_000;

test.describe.serial("client-urls-hmr-component-use", () => {
  test.skip(isCI, "file watcher unreliable on CI — run locally");

  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });

  test.setTimeout(isCI ? 120_000 : 90_000);

  const fixturePath = path.resolve(
    "./e2e/test-app/src/urls/client-urls-component-use.page.tsx",
  );
  const before = "isAction(ComponentUseActions.bumpComponentUseStats)";
  const after = "isAction(ComponentUseActions.otherComponentUseAction)";
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
   * On a fresh item page, click `button`; once the action committed (the
   * layout's loader re-runs on every action), did the stats loader re-run?
   * "unsettled" when the page did not load or the action did not commit: an
   * edit's reload or the dev server's transient re-discovery can land
   * mid-call. Every wait is bounded, so the caller's poll retries.
   */
  async function decide(
    page: Page,
    button: "ccu-bump" | "ccu-other",
  ): Promise<"reran" | "held" | "unsettled"> {
    try {
      await page.goto(f.url("/client-urls-component-use/items/alpha"), {
        timeout: 8_000,
      });
      await page.waitForFunction(
        () => document.documentElement.hasAttribute("data-hydrated"),
        undefined,
        { timeout: 8_000 },
      );
      await waitForHydration(page);
      const read = (id: string) =>
        testId(page, id).textContent({ timeout: 5_000 });
      const stats = await read("ccu-stats");
      const shell = await read("ccu-shell");
      await testId(page, button).click({ timeout: 5_000 });
      await expect
        .poll(() => read("ccu-shell"), { timeout: 5_000 })
        .not.toBe(shell);
      return (await read("ccu-stats")) === stats ? "held" : "reran";
    } catch {
      return "unsettled";
    }
  }

  /** Save the fixture and wait for the dev server's re-discovery. */
  async function saveAndRediscover(content: string): Promise<void> {
    const output = f.proc().stdout().length;
    writeFileBumpMtime(fixturePath, content);
    await expect
      .poll(
        () => ROUTE_REDISCOVERY_PATTERN.test(f.proc().stdout().slice(output)),
        { timeout: WATCHER_TIMEOUT },
      )
      .toBe(true);
  }

  /**
   * Click the index's link to item alpha with its request held, and read the
   * skeleton the browser renders from its group records meanwhile.
   */
  async function skeletonOnClick(page: Page): Promise<string | null> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      "**/client-urls-component-use/items/alpha*",
      async (route) => {
        await gate;
        await route.continue();
      },
      { times: 1 },
    );
    try {
      await testId(page, "ccu-to-alpha").click();
      return await testId(page, "ccu-skeleton").textContent();
    } finally {
      release();
    }
  }

  test("editing a component's .use predicate changes the next action's decision without a restart", async ({
    page,
  }) => {
    expect(originalContent).toContain(before);
    await expect
      .poll(() => decide(page, "ccu-bump"), { timeout: WATCHER_TIMEOUT })
      .toBe("reran");
    expect(await decide(page, "ccu-other")).toBe("held");

    // Match the other action instead.
    writeFileBumpMtime(fixturePath, originalContent.replace(before, after));
    await expect
      .poll(() => decide(page, "ccu-other"), { timeout: WATCHER_TIMEOUT })
      .toBe("reran");
    expect(await decide(page, "ccu-bump")).toBe("held");

    // A literal: the refreshed projection carries it.
    writeFileBumpMtime(
      fixturePath,
      originalContent.replace(
        /revalidate\(\(\{ isAction \}\) =>[\s\S]*?\),\n    \),/,
        "revalidate(false),",
      ),
    );
    await expect
      .poll(() => decide(page, "ccu-bump"), { timeout: WATCHER_TIMEOUT })
      .toBe("held");

    // Restore: the original decision is back.
    writeFileBumpMtime(fixturePath, originalContent);
    await expect
      .poll(() => decide(page, "ccu-bump"), { timeout: WATCHER_TIMEOUT })
      .toBe("reran");
    expect(await decide(page, "ccu-other")).toBe("held");
  });

  test("an in-place .use edit reaches the browser's group records; a markup edit stays a Fast Refresh", async ({
    page,
  }) => {
    const skeleton = '<p data-testid="ccu-skeleton">loading item</p>';
    const shell = '<p data-testid="ccu-shell">{data}</p>';
    const edited = skeleton.replace("item", "item, edited");
    expect(originalContent).toContain(skeleton);
    expect(originalContent).toContain(shell);
    // The watcher re-projects a module it has not seen and any save that
    // changes a `.use`: leave it knowing the original.
    await saveAndRediscover(originalContent.replace(skeleton, edited));
    await saveAndRediscover(originalContent);

    await page.goto(f.url("/client-urls-component-use"));
    await waitForHydration(page);
    await testId(page, "ccu-layout").evaluate((el) =>
      el.setAttribute("data-e2e-kept", "1"),
    );

    // Markup only: Fast Refresh, the layout keeps its instance, and the
    // server does not re-discover.
    const markup = originalContent.replace(
      shell,
      '<p data-testid="ccu-shell" data-edited="">{data}</p>',
    );
    const output = f.proc().stdout().length;
    writeFileBumpMtime(fixturePath, markup);
    await expect(testId(page, "ccu-shell")).toHaveAttribute("data-edited", "", {
      timeout: WATCHER_TIMEOUT,
    });
    await page.waitForTimeout(1_000);
    expect(f.proc().stdout().slice(output)).not.toMatch(
      ROUTE_REDISCOVERY_PATTERN,
    );
    await expect(testId(page, "ccu-layout")).toHaveAttribute(
      "data-e2e-kept",
      "1",
    );

    // A `.use` edit in place, no page.goto: the next navigation in the group
    // renders the edited loading(). The update re-evaluates the group, as a
    // group edit does. The page's own requests wait out the re-discovery:
    // one mid-pass can meet a half-refreshed projection.
    const hmr = await captureHmrEvents(page);
    const appRequest = (url: URL) =>
      url.pathname.startsWith("/client-urls-component-use");
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    await page.route(appRequest, async (route) => {
      await settled;
      await route.fallback();
    });
    try {
      await saveAndRediscover(markup.replace(skeleton, edited));
    } finally {
      settle();
      await page.unrouteAll({ behavior: "wait" });
    }
    await expect
      .poll(() => hmr.updates.join("\n"), { timeout: WATCHER_TIMEOUT })
      .toContain("client-urls-component-use.page.tsx");
    hmr.dispose();
    // The group's own update and what follows it land right after.
    await page.waitForTimeout(1_500);
    await testId(page, "ccu-index").waitFor();
    await page.waitForFunction(() =>
      document.documentElement.hasAttribute("data-hydrated"),
    );
    // One click: a later one could follow a reload the server's new version
    // forces, which would hide stale records.
    expect(await skeletonOnClick(page)).toBe("loading item, edited");
    await expect(testId(page, "ccu-item-data")).toHaveText("item:alpha");
  });
});
