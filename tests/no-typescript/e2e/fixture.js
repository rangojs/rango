import path from "node:path";
import test from "@playwright/test";
import {
  runCli as harnessRunCli,
  ServerGuard,
} from "@rangojs/router/testing/e2e";
import { assertFixtureModeMatchesProject } from "@shared/e2e";
import { waitForServer } from "./helper.js";

function runCli(options) {
  return harnessRunCli({
    ...options,
    // Force the server to bind a concrete IPv4 host so the printed origin is
    // unambiguous (no `localhost` -> IPv4/IPv6 mismatch with another listener
    // on the same port). Harmless for the non-server `pnpm build` spawn.
    env: { ...options.env, RANGO_NOTS_HOST: "127.0.0.1" },
  });
}

export function useFixture(options) {
  // Owns every process this fixture spawns; afterAll disposes it, whether or
  // not beforeAll got as far as a ready server (ServerGuard says why).
  let servers;
  let baseURL;

  const cwd = path.resolve(options.root);
  let proc;

  test.beforeAll(async ({}, testInfo) => {
    assertFixtureModeMatchesProject(options.mode, testInfo);
    // A guard per run of the hook: Playwright does not cancel a timed-out
    // hook, so its body can outlive afterAll and must not start anything
    // under the next run's guard.
    const guard = (servers = new ServerGuard());
    // Tracked as soon as it is spawned, before any await.
    const start = (cli) => {
      guard.assertLive();
      return guard.track(runCli(cli));
    };
    if (options.mode === "dev") {
      proc = start({
        command: options.command ?? `pnpm dev`,
        label: `${options.root}:dev`,
        cwd,
        ...options.cliOptions,
      });
      baseURL = await proc.findURL();
      // "Port printed" != "ready to serve" for vite dev: settle two consecutive
      // OK responses to absorb the first-request dep-optimizer cycle.
      await waitForServer(`${baseURL}/`, {
        settleOks: 2,
        getOutput: () => ({ stdout: proc.stdout(), stderr: proc.stderr() }),
      });
    }
    if (options.mode === "build") {
      const hasBuildDep = testInfo.project.dependencies.includes("build");
      if (!process.env.TEST_SKIP_BUILD && !hasBuildDep) {
        const buildProc = start({
          command: options.buildCommand ?? `pnpm build`,
          label: `${options.root}:build`,
          cwd,
          ...options.cliOptions,
        });
        await buildProc.done;
      }
      proc = start({
        command: options.command ?? `pnpm preview`,
        label: `${options.root}:preview`,
        cwd,
        ...options.cliOptions,
      });
      baseURL = await proc.findURL();
      // Preview serves static dist (no optimizer), but still confirm it is
      // actually serving before tests navigate.
      await waitForServer(`${baseURL}/`, {
        getOutput: () => ({ stdout: proc.stdout(), stderr: proc.stderr() }),
      });
    }
  });

  test.afterAll(async () => {
    await servers?.dispose();
  });

  return {
    mode: options.mode,
    root: cwd,
    url: (url = "./") => new URL(url, baseURL).href,
    proc: () => proc,
  };
}
