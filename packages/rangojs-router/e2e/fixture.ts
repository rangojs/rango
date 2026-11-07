import type { SpawnOptions } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "@playwright/test";
import {
  runCli as harnessRunCli,
  ServerGuard,
} from "@rangojs/router/testing/e2e";
import {
  assertFixtureModeMatchesProject,
  consoleGuardMode,
  installConsoleGuard,
} from "@shared/e2e";

/**
 * The harness's runCli with this suite's environment: the repo-only suspense
 * audit (src/internal-suspense-audit.ts), and CI=true so vite keeps running
 * once its stdin reaches EOF (the harness's createUseFixture says why).
 */
function runCli(options: { command: string; label?: string } & SpawnOptions) {
  return harnessRunCli({
    ...options,
    env: {
      CI: "true",
      INTERNAL_RANGO_SUSPENSE_AUDIT: "1",
      ...options.env,
    },
  });
}

function tailOutput(text: string, maxChars = 4000): string {
  if (!text) return "(empty)";
  if (text.length <= maxChars) return text;
  return `...${text.slice(-maxChars)}`;
}

function createIsolatedViteCacheDir(
  cwd: string,
  projectName: string,
  mode: "dev" | "build" | undefined,
) {
  const safeProjectName = projectName.replace(/[^a-zA-Z0-9_-]/g, "-");
  return path.join(
    cwd,
    ".vite-isolated",
    `${safeProjectName}-${mode ?? "server"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

async function waitForReady(
  url: string,
  getOutput?: () => { stdout: string; stderr: string },
  timeoutMs = process.env.CI ? 60000 : 30000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const output = getOutput?.();
  const details = output
    ? `\nRecent stdout:\n${tailOutput(output.stdout)}\n\nRecent stderr:\n${tailOutput(output.stderr)}`
    : "";
  throw new Error(`Server not ready after ${timeoutMs}ms: ${url}${details}`);
}

/**
 * Warm up an isolated dev server by making real SSR requests.
 * The first SSR request triggers Vite's dep optimizer to discover SSR deps.
 * After optimization, modules are re-evaluated and in-memory caches reset.
 * We retry until the server returns a stable 200, absorbing the dep
 * optimization cycle so subsequent test requests hit a settled server.
 */
async function warmupDevServer(url: string) {
  const deadline = Date.now() + 30_000;
  let lastOk = 0;
  // Need two consecutive OK responses to confirm the server is settled
  // (first OK may precede dep optimization, second confirms stability).
  while (Date.now() < deadline && lastOk < 2) {
    try {
      const res = await fetch(url, {
        headers: { accept: "text/html" },
      });
      if (res.ok) {
        await res.text(); // consume body to complete SSR pipeline
        lastOk++;
      } else {
        lastOk = 0;
      }
    } catch {
      lastOk = 0;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export type Fixture = ReturnType<typeof useFixture>;

export function useFixture(options: {
  root: string;
  mode?: "dev" | "build";
  command?: string;
  buildCommand?: string;
  cliOptions?: SpawnOptions;
  isolatedServer?: boolean;
  /** Path to poll for readiness (default: "/"). Use when basename moves routes off "/". */
  readyPath?: string;
}) {
  // Owns every process this fixture spawns; afterAll disposes it, whether or
  // not beforeAll got as far as a ready server (ServerGuard says why).
  let servers: ServerGuard | undefined;
  let baseURL!: string;

  const cwd = path.resolve(options.root);
  let proc!: ReturnType<typeof runCli>;
  let isolatedViteCacheDir: string | undefined;

  // Every dev test runs under the console guard (@shared/e2e console-guard.ts).
  // A record run also covers builds, to read the router's own messages there.
  if (options.mode === "dev" || consoleGuardMode() === "record") {
    installConsoleGuard({ app: "rangojs-router" });
  }

  test.beforeAll(async ({}, testInfo) => {
    assertFixtureModeMatchesProject(options.mode, testInfo);
    // A guard per run of the hook: Playwright does not cancel a timed-out
    // hook, so its body can outlive afterAll and must not start anything
    // under the next run's guard.
    const guard = (servers = new ServerGuard());
    // Tracked as soon as it is spawned, before any await.
    const start = (cli: Parameters<typeof runCli>[0]) => {
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
    const cliEnv = {
      ...options.cliOptions?.env,
      ...(isolatedViteCacheDir
        ? { RANGO_E2E_VITE_CACHE_DIR: isolatedViteCacheDir }
        : {}),
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
          env: cliEnv,
        });
        const port = await proc.findPort();
        baseURL = `http://localhost:${port}`;
        const readyUrl = options.readyPath
          ? `${baseURL}${options.readyPath}`
          : baseURL;
        await waitForReady(readyUrl, () => ({
          stdout: proc.stdout(),
          stderr: proc.stderr(),
        }));
        // Isolated dev servers need a warmup SSR request to trigger Vite's
        // dep optimizer before real tests run. The first full SSR request
        // discovers deps (e.g. spin-delay) → `ERR_OUTDATED_OPTIMIZED_DEP`
        // → module re-evaluation → loss of in-memory cache. Without this,
        // cache tests see different values on the second request.
        if (options.isolatedServer) {
          await warmupDevServer(readyUrl);
        }
      }
    }
    if (options.mode === "build") {
      // Reuse shared preview server if the project has a baseURL configured
      // and the fixture root matches the default test-app (other roots like
      // e2e-basic or e2e-timeout need their own server).
      const isDefaultRoot = cwd === path.resolve("./e2e/test-app");
      const sharedURL =
        isDefaultRoot &&
        !options.isolatedServer &&
        testInfo.project.use.baseURL;
      if (sharedURL) {
        baseURL = sharedURL;
      } else {
        const hasBuildDep = testInfo.project.dependencies.includes("build");
        // Only skip building when the build dependency covers THIS app.
        // The "build" setup project only builds the default test-app,
        // so non-default roots (e2e-timeout, e2e-basic) always need their own build.
        if (!process.env.TEST_SKIP_BUILD && !(hasBuildDep && isDefaultRoot)) {
          const buildProc = start({
            command: options.buildCommand ?? `pnpm build`,
            label: `${options.root}:build`,
            cwd,
            ...options.cliOptions,
            env: cliEnv,
          });
          await buildProc.done;
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
          stdout: proc.stdout(),
          stderr: proc.stderr(),
        }));
      }
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
}
