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
  const done = new Promise<void>((resolve) => {
    child.on("exit", (code) => {
      if (code !== null && code !== 0 && code !== 143 && process.platform !== "win32") {
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
            `Timeout waiting for server to start after 60s. Stdout: ${stdout}`
          )
        );
      }, 60000);

      child.stdout!.on("data", (data) => {
        stdout += stripVTControlCharacters(String(data));
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
            `Server exited with code ${code}.\nStdout: ${stdout}\nStderr: ${stderr}`
          )
        );
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

export function useFixture(options: {
  root: string;
  mode?: "dev" | "build";
  command?: string;
  cliOptions?: SpawnOptions;
}) {
  let cleanup: (() => Promise<void>) | undefined;
  let baseURL!: string;

  const cwd = path.resolve(options.root);
  let proc!: ReturnType<typeof runCli>;

  test.beforeAll(async ({}, testInfo) => {
    const sharedURL = testInfo.project.use.baseURL;
    if (sharedURL) {
      baseURL = sharedURL;
    } else {
      proc = runCli({
        command: options.command ?? `pnpm dev`,
        label: `${options.root}:dev`,
        cwd,
        ...options.cliOptions,
      });
      const port = await proc.findPort();
      baseURL = `http://localhost:${port}`;
      await waitForReady(baseURL);
      cleanup = async () => {
        proc.kill();
        await proc.done;
      };
    }
  });

  test.afterAll(async () => {
    await cleanup?.();
  });

  return {
    url: (url: string = "./") => new URL(url, baseURL).href,
  };
}
