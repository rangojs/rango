import { type SpawnOptions, spawn } from "node:child_process";
import path from "node:path";
import { stripVTControlCharacters, styleText } from "node:util";
import test from "@playwright/test";
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
  let exitCode: number | null = null;
  const done = new Promise<void>((resolve) => {
    child.on("exit", (code) => {
      exitCode = code;
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
        reject(new Error("Timeout waiting for server to start"));
      }, 60000);

      child.stdout!.on("data", (data) => {
        stdout += stripVTControlCharacters(String(data));
        const match = stdout.match(/http:\/\/(?:localhost|[\d.]+):(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(Number(match[1]));
        }
      });
    });
  }

  function kill() {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
    } else {
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
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
    exitCode: () => exitCode,
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
  let cleanup: (() => Promise<void>) | undefined;
  let baseURL!: string;

  const cwd = path.resolve(options.root);
  let proc!: ReturnType<typeof runCli>;

  test.beforeAll(async () => {
    if (options.mode === "dev") {
      proc = runCli({
        command: options.command ?? `pnpm dev`,
        label: `${options.root}:dev`,
        cwd,
        ...options.cliOptions,
      });
      // Register teardown BEFORE awaiting findPort: if findPort times out it
      // throws out of beforeAll, and a cleanup assigned only afterwards would be
      // undefined, leaking the detached dev server (holding its port).
      cleanup = async () => {
        proc.kill();
        await proc.done;
      };
      const port = await proc.findPort();
      baseURL = `http://localhost:${port}`;
    }
    if (options.mode === "build") {
      if (!process.env.TEST_SKIP_BUILD) {
        const buildProc = runCli({
          command: options.buildCommand ?? `pnpm build`,
          label: `${options.root}:build`,
          cwd,
          ...options.cliOptions,
        });
        await buildProc.done;
        // Fail the production suite on a build failure instead of serving stale
        // .vercel/output (a false green). A build runs to completion and is never
        // a teardown target, so it must exit 0 (unlike the long-running preview
        // proc, which is SIGTERM'd at teardown).
        const code = buildProc.exitCode();
        if (code !== 0) {
          throw new Error(
            `build failed (exit ${code}) for ${options.root}; aborting production e2e.\n${buildProc.stderr()}`,
          );
        }
      }
      proc = runCli({
        command: options.command ?? `pnpm preview`,
        label: `${options.root}:preview`,
        cwd,
        ...options.cliOptions,
      });
      // Register teardown BEFORE awaiting findPort (see the dev branch): a
      // findPort timeout would otherwise leak the detached preview server.
      cleanup = async () => {
        proc.kill();
        await proc.done;
      };
      const port = await proc.findPort();
      baseURL = `http://localhost:${port}`;
    }
  });

  test.afterAll(async () => {
    await cleanup?.();
  });

  return {
    mode: options.mode,
    root: cwd,
    url: (url: string = "./") => new URL(url, baseURL).href,
    proc: () => proc,
  };
}
