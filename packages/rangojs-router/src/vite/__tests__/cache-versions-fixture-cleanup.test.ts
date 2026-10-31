/**
 * The cache-versions build helper must not leave vite builds running when a
 * `beforeAll` times out: a build still writing into the workspace made the
 * temp-dir cleanup fail with ENOTEMPTY. Cleanup now kills the builds it
 * started, waits for them, and refuses to start new ones.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildFixture,
  createFixtureWorkspace,
} from "./helpers/build-cache-versions-fixture.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, ms: number): Promise<void> {
  for (let waited = 0; !predicate(); waited += 50) {
    if (waited >= ms) throw new Error("timed out waiting for the build");
    await sleep(50);
  }
}

describe("cache-versions fixture workspace cleanup", () => {
  it("kills a build that is still running and removes the workspace", async () => {
    const workspace = createFixtureWorkspace();
    const marker = join(workspace.dir, "build-started");
    // A config that loads forever: the build is alive (the interval keeps the
    // event loop busy, else Node exits 13 on the unsettled await) until killed.
    const hang = [
      `hang: await (async () => {`,
      `  (await import("node:fs")).writeFileSync(${JSON.stringify(marker)}, "");`,
      `  await new Promise(() => setInterval(() => {}, 1000));`,
      `})()`,
    ].join("\n");

    const build = buildFixture(join(workspace.dir, "hang", "app"), {
      viteConfig: hang,
    }).then(
      () => "resolved",
      () => "rejected",
    );
    await waitFor(() => existsSync(marker), 60_000);

    await workspace.cleanup();

    const outcome = await Promise.race([
      build,
      sleep(10_000).then(() => "still running"),
    ]);
    expect(outcome).toBe("rejected");
    expect(existsSync(workspace.dir)).toBe(false);
  }, 120_000);

  it("starts no build after cleanup", async () => {
    const workspace = createFixtureWorkspace();
    await workspace.cleanup();
    await expect(
      buildFixture(join(workspace.dir, "late", "app")),
    ).rejects.toThrow(/cleaned up/);
    expect(existsSync(workspace.dir)).toBe(false);
  }, 60_000);
});
