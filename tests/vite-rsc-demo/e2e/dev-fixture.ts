import { test as base, expect } from "@playwright/test";
import { runCli, ServerGuard } from "@rangojs/router/testing/e2e";
import { assertFixtureModeMatchesProject } from "@shared/e2e";

type DevServerFixture = {
  devServerURL: string;
};

export const test = base.extend<{}, DevServerFixture>({
  devServerURL: [
    async ({}, use, workerInfo) => {
      // A dev server serves the dev project only; a "(production)" describe
      // written with devTest would run against it in the production project.
      assertFixtureModeMatchesProject("dev", {
        titlePath: base.info().titlePath,
        project: workerInfo.project,
      });
      // runCli makes the server a process-group leader, so the guard's kill
      // reaches vite, the grandchild pnpm spawns.
      const servers = new ServerGuard();
      // Tracked as soon as it is spawned, before anything is awaited.
      const server = servers.track(
        runCli({ command: "pnpm dev", label: ".:dev", cwd: process.cwd() }),
      );
      try {
        // Rejects when the server exits or prints no URL within 60 s, and the
        // finally below stops it, instead of hanging until the fixture times out.
        const port = await server.findPort();
        await use(`http://localhost:${port}`);
      } finally {
        await servers.dispose();
      }
    },
    { scope: "worker" },
  ],
});

export { expect };

export function devURL(baseURL: string, path: string = "./") {
  return new URL(path, baseURL).href;
}
