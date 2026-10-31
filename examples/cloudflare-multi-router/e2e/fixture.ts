import { type SpawnOptions, spawn } from "node:child_process";
import path from "node:path";
import { stripVTControlCharacters, styleText } from "node:util";
import test from "@playwright/test";
import { ServerGuard } from "@shared/e2e";
import { x } from "tinyexec";

function runCli(options: { command: string; label?: string } & SpawnOptions) {
  const [name, ...args] = options.command.split(" ");
  const child = x(name!, args, {
    nodeOptions: { ...options, detached: true },
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
        reject(new Error("Timeout waiting for dev server to start"));
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
    });
  }

  function kill(signal: NodeJS.Signals = "SIGTERM") {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
    } else {
      // Kill entire process group on Unix (wrangler spawns child processes).
      // ServerGuard escalates to SIGKILL for a group that outlives the wait.
      try {
        process.kill(-child.pid!, signal);
      } catch {
        // Process group kill failed, try direct kill
        child.kill(signal);
      }
    }
  }

  return {
    proc: child,
    done,
    get pid() {
      return child.pid;
    },
    findPort,
    kill,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

export type Fixture = ReturnType<typeof useFixture>;

export function useFixture(options: {
  root: string;
  mode?: "dev" | "build";
  command?: string;
  buildCommand?: string;
  cliOptions?: SpawnOptions;
}) {
  // Owns every process this fixture spawns; afterAll disposes it, whether or
  // not beforeAll got as far as a ready server (ServerGuard says why).
  let servers: ServerGuard | undefined;
  let baseURL!: string;

  const cwd = path.resolve(options.root);
  let proc!: ReturnType<typeof runCli>;

  test.beforeAll(async () => {
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
      proc = start({
        command: options.command ?? `pnpm dev`,
        label: `${options.root}:dev`,
        cwd,
        ...options.cliOptions,
      });
      const port = await proc.findPort();
      baseURL = `http://localhost:${port}`;
    }
    if (options.mode === "build") {
      if (!process.env.TEST_SKIP_BUILD) {
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
    }
  });

  test.afterAll(async () => {
    await servers?.dispose();
  });

  return {
    mode: options.mode,
    root: cwd,
    url: (url: string = "./") => new URL(url, baseURL).href,
    port: () => new URL(baseURL).port,
    proc: () => proc,
  };
}
