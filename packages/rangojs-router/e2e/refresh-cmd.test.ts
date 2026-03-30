import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";

/**
 * Tests for bindRefreshUtils() Vite plugin.
 *
 * Dev-only: the plugin uses `apply: "serve"` and is not loaded during
 * `vite build` or `vite preview`, so no production test is applicable.
 */
test.describe("refresh-cmd (dev)", () => {
  // Spawn Vite directly (not via pnpm) so the stdin pipe reaches Vite's
  // process.stdin — pnpm doesn't forward stdin to child scripts.
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
    command: "./node_modules/.bin/vite",
  });

  async function expectReloadFromInput(
    page: import("@playwright/test").Page,
    input: Buffer,
    expectedLog: string,
  ) {
    // Track HMR connection messages to detect page reload
    const consoleMsgs: string[] = [];
    page.on("console", (msg) => consoleMsgs.push(msg.text()));

    await page.goto(f.url("/"));

    // Wait for the initial HMR websocket connection
    await expect
      .poll(() => consoleMsgs.join("\n"), { timeout: 10_000 })
      .toContain("[vite] connected.");

    const connectionCountBefore = consoleMsgs.filter(
      (m) => m === "[vite] connected.",
    ).length;

    const { proc: child } = f.proc();
    expect(child.stdin, "child process stdin must be writable").toBeTruthy();
    child.stdin!.write(input);

    await expect
      .poll(() => f.proc().stdout(), {
        timeout: 5_000,
        intervals: [200, 500],
        message: `server should log '${expectedLog}'`,
      })
      .toContain(expectedLog);

    await expect
      .poll(() => consoleMsgs.filter((m) => m === "[vite] connected.").length, {
        timeout: 10_000,
        intervals: [200, 500, 1000],
        message:
          "HMR client should reconnect after full reload (new '[vite] connected.' message)",
      })
      .toBeGreaterThan(connectionCountBefore);
  }

  test("Ctrl+R in terminal triggers full browser reload", async ({ page }) => {
    await expectReloadFromInput(
      page,
      Buffer.from([0x12]),
      "browser reload (ctrl+r)",
    );
  });

  test("e + Enter in terminal triggers full browser reload", async ({
    page,
  }) => {
    await expectReloadFromInput(
      page,
      Buffer.from("e\n"),
      "browser reload (e+enter)",
    );
  });
});
