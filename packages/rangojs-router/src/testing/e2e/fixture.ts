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
  type SpawnOptions,
  waitForReady,
  warmupDevServer,
} from "./server.js";

export interface FixtureOptions {
  /** Absolute or cwd-relative path to the consumer app under test. */
  root: string;
  mode?: "dev" | "build";
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
  mode: "dev" | "build" | undefined;
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
    let cleanup: (() => Promise<void>) | undefined;
    let baseURL!: string;

    const cwd = path.resolve(options.root);
    let proc: RunCliHandle | undefined;
    let isolatedViteCacheDir: string | undefined;

    test.beforeAll(async ({}, testInfo) => {
      if (options.isolatedServer) {
        isolatedViteCacheDir = createIsolatedViteCacheDir(
          cwd,
          testInfo.project.name,
          options.mode,
        );
      }
      const cliEnv = {
        ...options.cliOptions?.env,
        ...(isolatedViteCacheDir
          ? { RANGO_E2E_VITE_CACHE_DIR: isolatedViteCacheDir }
          : {}),
      };

      if (options.mode === "dev") {
        proc = runCli({
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
        cleanup = async () => {
          proc!.kill();
          await proc!.done;
        };
      }

      if (options.mode === "build") {
        const skipBuild = options.skipBuild || !!process.env.TEST_SKIP_BUILD;
        if (!skipBuild) {
          const buildProc = runCli({
            command: options.buildCommand ?? `pnpm build`,
            label: `${options.root}:build`,
            cwd,
            ...options.cliOptions,
            env: cliEnv,
          });
          await buildProc.done;
        }
        proc = runCli({
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
        cleanup = async () => {
          proc!.kill();
          await proc!.done;
        };
      }
    });

    test.afterAll(async () => {
      await cleanup?.();
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
