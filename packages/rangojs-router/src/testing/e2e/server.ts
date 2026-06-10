// Node-only server-lifecycle machinery for the e2e harness. Contains no
// Playwright imports so it can be loaded in a plain-node process. Lifted from
// the internal e2e/fixture.ts and parameterized for consumer apps.

import { type SpawnOptions, spawn } from "node:child_process";
import path from "node:path";
import { stripVTControlCharacters, styleText } from "node:util";
import { x } from "tinyexec";

export type { SpawnOptions };

export interface RunCliHandle {
  proc: ReturnType<typeof x>["process"];
  done: Promise<void>;
  /**
   * Resolves with the process's exit code (null if killed by signal) when it
   * exits. Unlike `done`, callers can branch on a nonzero code. Used to fail
   * the build step loudly; the long-running serve processes never inspect it.
   */
  exitCode: Promise<number | null>;
  findPort: (timeoutMs?: number) => Promise<number>;
  kill: () => void;
  stdout: () => string;
  stderr: () => string;
}

export function runCli(
  options: { command: string; label?: string } & SpawnOptions,
): RunCliHandle {
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
  let resolveExitCode!: (code: number | null) => void;
  const exitCode = new Promise<number | null>((resolve) => {
    resolveExitCode = resolve;
  });
  const done = new Promise<void>((resolve) => {
    child.on("exit", (code) => {
      if (code !== 0 && code !== 143 && process.platform !== "win32") {
        console.log(styleText("magenta", `${label}`), `exit code ${code}`);
      }
      resolveExitCode(code);
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
    exitCode,
    findPort,
    kill,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

export function tailOutput(text: string, maxChars = 4000): string {
  if (!text) return "(empty)";
  if (text.length <= maxChars) return text;
  return `...${text.slice(-maxChars)}`;
}

export function createIsolatedViteCacheDir(
  cwd: string,
  projectName: string,
  mode: "dev" | "build" | undefined,
): string {
  const safeProjectName = projectName.replace(/[^a-zA-Z0-9_-]/g, "-");
  return path.join(
    cwd,
    ".vite-isolated",
    `${safeProjectName}-${mode ?? "server"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

export async function waitForReady(
  url: string,
  getOutput?: () => { stdout: string; stderr: string },
  timeoutMs: number = process.env.CI ? 60000 : 30000,
): Promise<void> {
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
export async function warmupDevServer(url: string): Promise<void> {
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
