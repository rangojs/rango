import { type SpawnOptions, spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters, styleText } from "node:util";
import test from "@playwright/test";
import { x } from "tinyexec";

function runCli(options: { command: string; label?: string } & SpawnOptions) {
  const [name, ...args] = options.command.split(" ");
  // Vite registers `process.stdin.on("end", ...)` as parent-death detection and
  // calls process.exit() when stdin reaches EOF, unless process.env.CI === "true"
  // (see vite's setupSIGTERMListener). Servers spawned here receive an stdin that
  // hits EOF immediately, so without CI=true the dev/preview server shuts itself
  // down before it finishes starting. Real CI runners set CI=true; mirror that for
  // locally-spawned servers so they stay alive for the duration of the tests.
  const child = x(name!, args, {
    nodeOptions: {
      ...options,
      // detached makes the child a process-group leader (pgid === pid), so the
      // kill() below can reap the WHOLE tree via process.kill(-pid). Without it
      // the child shares our group, process.kill(-pid) throws ESRCH and falls
      // back to killing only the direct child — leaving Vite/esbuild grandchildren
      // orphaned. Files that spawn many isolatedServer instances (cache.test.ts
      // spawns 21) then accumulate orphaned dev servers until the runner OOMs.
      detached: true,
      env: { ...process.env, CI: "true", ...options.env },
    },
  }).process!;
  const label = `[${options.label ?? "cli"}]`;
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (data) => {
    stdout += stripVTControlCharacters(String(data));
    if (process.env.TEST_DEBUG) {
      console.log(styleText("cyan", label), data.toString());
    }
  });
  child.stderr!.on("data", (data) => {
    stderr += stripVTControlCharacters(String(data));
    if (process.env.TEST_DEBUG) {
      console.log(styleText("magenta", label), data.toString());
    }
  });
  const done = new Promise<void>((resolve) => {
    child.on("exit", (code, signal) => {
      if (
        code !== 0 &&
        code !== 143 &&
        signal !== "SIGTERM" &&
        process.platform !== "win32"
      ) {
        console.log(styleText("magenta", `${label}`), `exit code ${code}`);
      }
      resolve();
    });
  });

  async function findPort(timeoutMs = 60000): Promise<number> {
    let stdout = "";
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Timed out waiting for server to start after ${timeoutMs}ms. Stdout: ${stdout}`,
          ),
        );
      }, timeoutMs);

      child.stdout!.on("data", (data) => {
        stdout += stripVTControlCharacters(String(data));
        const match = stdout.match(/http:\/\/localhost:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(Number(match[1]));
        }
      });

      child.on("exit", (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(
            new Error(`Server exited with code ${code}. Stdout: ${stdout}`),
          );
        }
      });
    });
  }

  function kill() {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
    } else {
      // Kill entire process group (Vite spawns child processes like workerd).
      // Falls back to direct kill if process group kill fails.
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        child.kill();
      }
    }
  }

  return {
    proc: child,
    done,
    findPort,
    kill,
    stdout: () => stdout,
    stderr: () => stderr,
  };
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
  let cleanup: (() => Promise<void>) | undefined;
  let baseURL!: string;

  const cwd = path.resolve(options.root);
  let proc!: ReturnType<typeof runCli>;
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
      const sharedURL = !options.isolatedServer && testInfo.project.use.baseURL;
      if (sharedURL) {
        baseURL = sharedURL;
      } else {
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
        cleanup = async () => {
          proc.kill();
          await proc.done;
        };
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
          stdout: proc.stdout(),
          stderr: proc.stderr(),
        }));
        cleanup = async () => {
          proc.kill();
          await proc.done;
        };
      }
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
}
