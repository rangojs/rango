import { test as base, expect } from "@playwright/test";
import { runCli, ServerGuard } from "@rangojs/router/testing/e2e";
import { assertFixtureModeMatchesProject } from "@shared/e2e";
import { waitForServer } from "./helper.js";

// Worker-scoped dev server: one `vite dev` per Playwright worker, shared by all
// dev tests on that worker.
export const test = base.extend({
  devServerURL: [
    async ({}, use, workerInfo) => {
      // A dev server serves the dev project only; a "(production)" describe
      // written with devTest would run against it in the production project.
      assertFixtureModeMatchesProject("dev", {
        titlePath: base.info().titlePath,
        project: workerInfo.project,
      });
      // Each Playwright worker gets an isolated Vite cache dir so concurrent
      // dev servers don't race on the shared node_modules/.vite optimizer temp
      // dirs (ENOTEMPTY on first optimize).
      const cacheDir = `node_modules/.vite-dev-${process.env.TEST_PARALLEL_INDEX ?? process.pid}`;
      const servers = new ServerGuard();
      // Tracked as soon as it is spawned, before anything is awaited. runCli
      // makes it a process-group leader, so the guard's kill reaches vite, the
      // grandchild pnpm spawns.
      const server = servers.track(
        runCli({
          command: "pnpm dev",
          label: ".:dev",
          cwd: process.cwd(),
          env: {
            RANGO_NOTS_VITE_CACHE_DIR: cacheDir,
            // Bind a concrete IPv4 host so the printed origin is unambiguous
            // (avoids `localhost` resolving to a different IPv4/IPv6 listener
            // than the one this server bound when a port collides cross-stack).
            RANGO_NOTS_HOST: "127.0.0.1",
          },
        }),
      );

      // The guard stops the whole process group (the vite grandchild too) when
      // the fixture ends or fails anywhere below, a startup timeout included.
      try {
        // The full printed origin, used verbatim: the server binds 127.0.0.1,
        // so it is a concrete IPv4 address rather than `localhost`. Rejects
        // when the server exits or prints no URL within 60 s.
        const baseURL = await server.findURL();
        // "Port printed" != "ready to serve": wait for two consecutive OK
        // responses so the first SSR request's dep-optimizer cycle is absorbed
        // before any test navigates (otherwise the first nav can ERR_EMPTY_RESPONSE).
        await waitForServer(`${baseURL}/`, {
          settleOks: 2,
          getOutput: () => ({
            stdout: server.stdout(),
            stderr: server.stderr(),
          }),
        });
        await use(baseURL);
      } finally {
        await servers.dispose();
      }
    },
    { scope: "worker" },
  ],
});

export { expect };

export function devURL(baseURL, p = "./") {
  return new URL(p, baseURL).href;
}
