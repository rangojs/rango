// Consumer-facing server-lifecycle fixture. Parameterized lift of the internal
// e2e/fixture.ts: the test-app-specific shared-server reuse and default-root
// build skipping are removed; a consumer points `root` at their own app.

import { rm } from "node:fs/promises";
import path from "node:path";
import type { TestType } from "@playwright/test";
import {
  createIsolatedViteCacheDir,
  runCli,
  type RunCliHandle,
  ServerGuard,
  type SpawnOptions,
  waitForReady,
  warmupDevServer,
} from "./server.js";

export interface FixtureOptions {
  /** Absolute or cwd-relative path to the consumer app under test. */
  root: string;
  /**
   * Server mode. Required: omitting it would spawn no server in beforeAll and
   * surface only as a bare "Invalid URL" from `url()` at first use, so we fail
   * eagerly at useFixture time instead.
   */
  mode: "dev" | "build";
  /** Override the server command (default: `pnpm dev` for dev, `pnpm preview` for build). */
  command?: string;
  /** Override the build command (default: `pnpm build`). */
  buildCommand?: string;
  cliOptions?: SpawnOptions;
  /** Spawn a per-suite server with an isolated Vite cache dir (dev only warmup). */
  isolatedServer?: boolean;
  /** Path to poll for readiness (default: "/"). Use when a basename moves routes off "/". */
  readyPath?: string;
  /** Skip the production build step (assumes an existing build). */
  skipBuild?: boolean;
}

export interface Fixture {
  mode: "dev" | "build";
  root: string;
  /** Resolve a path against the running server's base URL. */
  url: (url?: string) => string;
  /** The underlying spawned process handle (undefined before beforeAll). */
  proc: () => RunCliHandle | undefined;
}

/**
 * Build a `useFixture` bound to a consumer-provided Playwright `test` object.
 * The returned function registers `beforeAll`/`afterAll` hooks that spawn and
 * tear down a dev or preview server for the app at `options.root`.
 */
export function createUseFixture(
  test: TestType<any, any>,
): (options: FixtureOptions) => Fixture {
  return function useFixture(options: FixtureOptions): Fixture {
    if (options.mode !== "dev" && options.mode !== "build") {
      throw new Error(
        `useFixture: mode is required: 'dev' | 'build' (got ${JSON.stringify(options.mode)}).`,
      );
    }
    // Owns every process this fixture spawns; afterAll disposes it, whether
    // or not beforeAll got as far as a ready server (ServerGuard says why).
    let servers: ServerGuard | undefined;
    let baseURL!: string;

    const cwd = path.resolve(options.root);
    let proc: RunCliHandle | undefined;
    let isolatedViteCacheDir: string | undefined;

    test.beforeAll(async ({}, testInfo) => {
      // A guard per run of the hook: Playwright does not cancel a timed-out
      // hook, so its body can outlive afterAll and must not start anything
      // under the next run's guard.
      const guard = (servers = new ServerGuard());
      // Tracked as soon as it is spawned, before any await.
      const start = (cli: Parameters<typeof runCli>[0]): RunCliHandle => {
        guard.assertLive();
        return guard.track(runCli(cli));
      };
      if (options.isolatedServer) {
        isolatedViteCacheDir = createIsolatedViteCacheDir(
          cwd,
          testInfo.project.name,
          options.mode,
        );
      }
      // Vite registers `process.stdin.on("end", ...)` as parent-death
      // detection and calls process.exit() when stdin reaches EOF, unless
      // process.env.CI === "true" (see vite's setupSIGTERMListener). Real CI
      // runners set CI=true; mirror that for locally spawned servers so they
      // stay alive for the duration of the tests. `cliOptions.env` can
      // override it.
      const cliEnv = {
        CI: "true",
        ...options.cliOptions?.env,
        ...(isolatedViteCacheDir
          ? { RANGO_E2E_VITE_CACHE_DIR: isolatedViteCacheDir }
          : {}),
      };

      if (options.mode === "dev") {
        proc = start({
          command: options.command ?? `pnpm dev`,
          label: `${options.root}:dev`,
          cwd,
          ...options.cliOptions,
          env: cliEnv,
        });
        const port = await proc.findPort();
        baseURL = `http://localhost:${port}`;
        const readyUrl = options.readyPath
          ? `${baseURL}${options.readyPath}`
          : baseURL;
        await waitForReady(readyUrl, () => ({
          stdout: proc!.stdout(),
          stderr: proc!.stderr(),
        }));
        // Isolated dev servers need a warmup SSR request to trigger Vite's
        // dep optimizer before real tests run. The first full SSR request
        // discovers deps -> `ERR_OUTDATED_OPTIMIZED_DEP` -> module
        // re-evaluation -> loss of in-memory cache. Without this, cache
        // tests see different values on the second request.
        if (options.isolatedServer) {
          await warmupDevServer(readyUrl);
        }
      }

      if (options.mode === "build") {
        const skipBuild = options.skipBuild || !!process.env.TEST_SKIP_BUILD;
        if (!skipBuild) {
          const buildProc = start({
            command: options.buildCommand ?? `pnpm build`,
            label: `${options.root}:build`,
            cwd,
            ...options.cliOptions,
            env: cliEnv,
          });
          // Fail loudly on a nonzero build exit. Without this a failed build is
          // swallowed and preview serves the previous stale dist/ (green
          // production tests against old code), or times out with "Server not
          // ready" that never mentions the build failure. The captured build
          // output (stdout/stderr above) precedes this throw.
          const code = await buildProc.exitCode;
          if (code !== 0) {
            throw new Error(
              `Build failed with exit code ${code} for "${options.root}" ` +
                `(command: ${options.buildCommand ?? "pnpm build"}). ` +
                `See the captured build output above for the cause.`,
            );
          }
        }
        proc = start({
          command: options.command ?? `pnpm preview`,
          label: `${options.root}:preview`,
          cwd,
          ...options.cliOptions,
          env: cliEnv,
        });
        const port = await proc.findPort();
        baseURL = `http://localhost:${port}`;
        const buildReadyUrl = options.readyPath
          ? `${baseURL}${options.readyPath}`
          : baseURL;
        await waitForReady(buildReadyUrl, () => ({
          stdout: proc!.stdout(),
          stderr: proc!.stderr(),
        }));
      }
    });

    test.afterAll(async () => {
      await servers?.dispose();
      if (isolatedViteCacheDir) {
        await rm(isolatedViteCacheDir, { recursive: true, force: true });
      }
    });

    return {
      mode: options.mode,
      root: cwd,
      url: (url: string = "./") => new URL(url, baseURL).href,
      proc: () => proc,
    };
  };
}
