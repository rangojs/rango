import type { SpawnOptions } from "node:child_process";
import path from "node:path";
import test from "@playwright/test";
import { runCli, ServerGuard } from "@rangojs/router/testing/e2e";

async function waitForReady(url: string, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server not ready after ${timeoutMs}ms: ${url}`);
}

export function useFixture(options: {
  root: string;
  mode?: "dev" | "build";
  command?: string;
  cliOptions?: SpawnOptions;
}) {
  // Owns the process this fixture spawns; afterAll disposes it, whether or not
  // beforeAll got as far as a ready server (ServerGuard says why).
  let servers: ServerGuard | undefined;
  let baseURL!: string;

  const cwd = path.resolve(options.root);
  let proc!: ReturnType<typeof runCli>;

  test.beforeAll(async ({}, testInfo) => {
    const sharedURL = testInfo.project.use.baseURL;
    if (sharedURL) {
      baseURL = sharedURL;
    } else {
      // A guard per run of the hook: Playwright does not cancel a timed-out
      // hook, so its body can outlive afterAll and must not start anything
      // under the next run's guard.
      const guard = (servers = new ServerGuard());
      // Tracked as soon as it is spawned, before any await.
      proc = guard.track(
        runCli({
          command: options.command ?? `pnpm dev`,
          label: `${options.root}:dev`,
          cwd,
          ...options.cliOptions,
        }),
      );
      const port = await proc.findPort();
      baseURL = `http://localhost:${port}`;
      await waitForReady(baseURL);
    }
  });

  test.afterAll(async () => {
    await servers?.dispose();
  });

  return {
    url: (url: string = "./") => new URL(url, baseURL).href,
  };
}
