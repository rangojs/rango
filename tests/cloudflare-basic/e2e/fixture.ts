import { type SpawnOptions, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { stripVTControlCharacters, styleText } from "node:util";
import test from "@playwright/test";
import {
  assertFixtureModeMatchesProject,
  consoleGuardMode,
  installConsoleGuard,
  ServerGuard,
} from "@shared/e2e";
import { x } from "tinyexec";

function sanitizeNodeOptions(value?: string): string | undefined {
  if (!value) return value;
  const tokens = value.split(/\s+/).filter(Boolean);
  const filtered = tokens.filter((token) => !token.startsWith("--inspect"));
  return filtered.length > 0 ? filtered.join(" ") : undefined;
}

function runCli(options: { command: string; label?: string } & SpawnOptions) {
  const [name, ...args] = options.command.split(" ");
  // The repo-only suspense audit (src/internal-suspense-audit.ts).
  const env = {
    ...process.env,
    INTERNAL_RANGO_SUSPENSE_AUDIT: "1",
    ...options.env,
  };
  const sanitizedNodeOptions = sanitizeNodeOptions(env.NODE_OPTIONS);
  if (sanitizedNodeOptions) {
    env.NODE_OPTIONS = sanitizedNodeOptions;
  } else {
    delete env.NODE_OPTIONS;
  }
  const child = x(name!, args, {
    nodeOptions: { ...options, env, detached: true },
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
    child.on("exit", (code) => {
      // null = killed by signal, 0 = success, 143 = SIGTERM on Linux
      if (
        code !== null &&
        code !== 0 &&
        code !== 143 &&
        process.platform !== "win32"
      ) {
        console.log(styleText("magenta", `${label}`), `exit code ${code}`);
      }
      resolve();
    });
  });

  async function findPort(): Promise<number> {
    let stdout = "";
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Timeout waiting for server to start after 60s. Stdout: ${stdout}`,
          ),
        );
      }, 60000);

      child.stdout!.on("data", (data) => {
        stdout += stripVTControlCharacters(String(data));
        // Match URL with any host (localhost, 127.0.0.1, 0.0.0.0, etc.)
        const match = stdout.match(/http:\/\/(?:localhost|[\d.]+):(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(Number(match[1]));
        }
      });

      child.on("exit", (code) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `Server exited with code ${code}.\nStdout: ${stdout}\nStderr: ${stderr}`,
          ),
        );
      });
    });
  }

  function kill() {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
    } else {
      // Kill entire process group on Unix (wrangler spawns child processes)
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        // Process group kill failed, try direct kill
        child.kill("SIGTERM");
      }
      // Force kill after timeout if still running
      setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already dead
          }
        }
      }, 2000);
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
  let servers = new ServerGuard();
  let baseURL!: string;

  const cwd = path.resolve(options.root);
  let proc!: ReturnType<typeof runCli>;

  const awaitReady = async (): Promise<void> => {
    if (options.readyPath === false) return;
    await waitForReady(new URL(options.readyPath ?? "/", baseURL).href);
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
    const guard = (servers = new ServerGuard());
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
    await servers.dispose();
  });

  return {
    mode: options.mode,
    root: cwd,
    url: (url: string = "./") => new URL(url, baseURL).href,
    proc: () => proc,
  };
}
