import type { SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "@playwright/test";
import {
  runCli as harnessRunCli,
  ServerGuard,
  waitForReady,
} from "@rangojs/router/testing/e2e";
import {
  assertFixtureModeMatchesProject,
  consoleGuardMode,
  installConsoleGuard,
} from "@shared/e2e";

function sanitizeNodeOptions(value?: string): string | undefined {
  if (!value) return value;
  const tokens = value.split(/\s+/).filter(Boolean);
  const filtered = tokens.filter((token) => !token.startsWith("--inspect"));
  return filtered.length > 0 ? filtered.join(" ") : undefined;
}

/**
 * The harness's runCli with this suite's environment: the repo-only suspense
 * audit (src/internal-suspense-audit.ts) and NODE_OPTIONS without an
 * inspector flag, which would make every spawned node bind the same port.
 */
function runCli(options: { command: string; label?: string } & SpawnOptions) {
  return harnessRunCli({
    ...options,
    env: {
      INTERNAL_RANGO_SUSPENSE_AUDIT: "1",
      ...options.env,
      // undefined leaves NODE_OPTIONS out of the child's environment.
      NODE_OPTIONS: sanitizeNodeOptions(
        { ...process.env, ...options.env }.NODE_OPTIONS,
      ),
    },
  });
}

export type Fixture = ReturnType<typeof useFixture>;

export function useFixture(options: {
  root: string;
  mode?: "dev" | "build";
  command?: string;
  buildCommand?: string;
  cliOptions?: SpawnOptions;
  isolatedServer?: boolean;
  /**
   * Response-route readiness path; use this to avoid warming document SSR.
   * `false` waits for the listening port only, so the test's first request is
   * the server's first.
   */
  readyPath?: string | false;
}) {
  // Owns every process this fixture spawns; afterAll disposes it, whether or
  // not beforeAll got as far as a ready server (ServerGuard says why).
  let servers: ServerGuard | undefined;
  let baseURL!: string;

  const cwd = path.resolve(options.root);
  let proc!: ReturnType<typeof runCli>;

  const awaitReady = async (): Promise<void> => {
    if (options.readyPath === false) return;
    // 30 s, under the 60 s CI hook timeout (playwright.config.ts), so a
    // server that never answers fails here, with its output, rather than as a
    // bare beforeAll timeout. waitForReady's own CI default is 60 s.
    await waitForReady(
      new URL(options.readyPath ?? "/", baseURL).href,
      () => ({ stdout: proc.stdout(), stderr: proc.stderr() }),
      30_000,
    );
  };

  // Every dev test runs under the console guard (@shared/e2e console-guard.ts).
  // A record run also covers builds, to read the router's own messages there.
  if (options.mode === "dev" || consoleGuardMode() === "record") {
    installConsoleGuard({ app: "cloudflare-basic" });
  }

  test.beforeAll(async ({}, testInfo) => {
    assertFixtureModeMatchesProject(options.mode, testInfo);
    // A guard per run of the hook: Playwright does not cancel a timed-out
    // hook, so its body can outlive afterAll and must not start anything
    // under the next run's guard.
    // A group still up 2 s after SIGTERM is sent SIGKILL, which keeps the
    // teardown between suites short.
    const guard = (servers = new ServerGuard({ exitWaitMs: 2_000 }));
    // Tracked as soon as it is spawned, before any await.
    const start = (cli: Parameters<typeof runCli>[0]) => {
      guard.assertLive();
      return guard.track(runCli(cli));
    };
    if (options.mode === "dev") {
      const sharedURL = !options.isolatedServer && testInfo.project.use.baseURL;
      if (sharedURL) {
        baseURL = sharedURL;
      } else {
        proc = start({
          command: options.command ?? `pnpm dev`,
          label: `${options.root}:dev`,
          cwd,
          ...options.cliOptions,
        });
        const port = await proc.findPort();
        baseURL = `http://localhost:${port}`;
        await awaitReady();
      }
    }
    if (options.mode === "build") {
      const sharedURL = !options.isolatedServer && testInfo.project.use.baseURL;
      if (sharedURL) {
        baseURL = sharedURL;
      } else {
        const hasBuildDep = testInfo.project.dependencies.includes("build");
        const distExists = fs.existsSync(path.join(cwd, "dist"));
        if (!process.env.TEST_SKIP_BUILD && !hasBuildDep && !distExists) {
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
        const port = await proc.findPort();
        baseURL = `http://localhost:${port}`;
        await awaitReady();
      }
    }
  });

  test.afterAll(async () => {
    await servers?.dispose();
  });

  return {
    mode: options.mode,
    root: cwd,
    url: (url: string = "./") => new URL(url, baseURL).href,
    proc: () => proc,
  };
}
