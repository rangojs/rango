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
  /**
   * Stop the process and what it spawned (the whole process group). SIGTERM by
   * default; `stopServer` escalates to SIGKILL for a process that outlives the
   * wait.
   */
  kill: (signal?: NodeJS.Signals) => void;
  readonly pid: number | undefined;
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
  // detached makes the child a process-group leader (pgid === pid), so kill()
  // can signal the whole tree. `pnpm dev` spawns vite as a grandchild; without
  // it process.kill(-pid) throws ESRCH, the fallback child.kill() stops only
  // pnpm, and vite keeps running after the suite. Not on Windows: there
  // detached opens a console window per server, and kill() already ends the
  // tree with `taskkill /t`.
  const child = x(name!, args, {
    nodeOptions: {
      ...options,
      detached: process.platform !== "win32",
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

  function kill(signal: NodeJS.Signals = "SIGTERM") {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
    } else {
      // Kill entire process group (Vite spawns child processes like workerd).
      // Falls back to direct kill if process group kill fails.
      try {
        process.kill(-child.pid!, signal);
      } catch {
        child.kill(signal);
      }
    }
  }

  return {
    proc: child,
    done,
    exitCode,
    findPort,
    kill,
    get pid() {
      return child.pid;
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

/** How long `stopServer` waits for SIGTERM to take effect before SIGKILL. */
const STOP_WAIT_MS = 10_000;
/** How long `stopServer` waits for the SIGKILL to take effect. */
const KILL_WAIT_MS = 2_000;

/** Resolves true when `done` settled within `ms`, false when the timer won. */
async function exitedWithin(done: Promise<unknown>, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([done.then(() => true as const), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** True while a process of the group led by `pgid` exists (not on Windows). */
function groupAlive(pgid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    // EPERM: the group exists but belongs to someone else. Only ESRCH is gone.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Resolves true once `server.done` settled and no process of its group is left,
 * false when `ms` ran out first. The leader (`pnpm`) exiting says nothing about
 * the vite it spawned, which can outlive it, so the group is polled too.
 */
async function groupExitedWithin(
  server: RunCliHandle,
  ms: number,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  if (!(await exitedWithin(server.done, ms))) return false;
  const pgid = server.pid;
  if (pgid === undefined) return true;
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

/**
 * Stop a server started by `runCli` and wait for its whole process group to
 * exit: SIGTERM to the group, then SIGKILL (and a log naming the pid) for a
 * process that outlives the wait, so a leaked server is visible rather than
 * left holding its port.
 */
export async function stopServer(
  server: RunCliHandle,
  options: { exitWaitMs?: number } = {},
): Promise<void> {
  const exitWaitMs = options.exitWaitMs ?? STOP_WAIT_MS;
  server.kill();
  if (await groupExitedWithin(server, exitWaitMs)) return;
  console.error(
    `[rango e2e] server (pid ${server.pid ?? "unknown"}) ignored SIGTERM for ` +
      `${exitWaitMs} ms and was sent SIGKILL`,
  );
  server.kill("SIGKILL");
  await groupExitedWithin(server, KILL_WAIT_MS);
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
