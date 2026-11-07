// Node-only server-lifecycle machinery for the e2e harness. Contains no
// Playwright imports so it can be loaded in a plain-node process. The
// harness's own fixture and the repo's e2e fixtures all spawn and stop their
// servers through `runCli`, `ServerGuard` and `stopServers`.

import { type SpawnOptions, spawn } from "node:child_process";
import path from "node:path";
import { stripVTControlCharacters, styleText } from "node:util";
import { x } from "tinyexec";

export type { SpawnOptions };

/** A spawned process that `ServerGuard` and `stopServers` can stop. */
export interface GuardedServer {
  /**
   * Stop the process and what it spawned (the whole process group). SIGTERM by
   * default; `stopServers` escalates to SIGKILL for a process that outlives
   * the wait.
   */
  kill(signal?: NodeJS.Signals): void;
  /** Settles when the process has exited. Treated as possibly rejecting. */
  done: Promise<unknown>;
  /** The process group to wait for, and the pid named in the SIGKILL log. */
  pid?: number;
}

export interface RunCliHandle extends GuardedServer {
  proc: ReturnType<typeof x>["process"];
  done: Promise<void>;
  /**
   * Resolves with the process's exit code (null if killed by signal) when it
   * exits. Unlike `done`, callers can branch on a nonzero code. Used to fail
   * the build step loudly; the long-running serve processes never inspect it.
   */
  exitCode: Promise<number | null>;
  /**
   * Resolves with the first origin the process prints
   * (`http://localhost:5173`, `http://127.0.0.1:8787`), output printed before
   * the call included. Rejects when the process exits first or `timeoutMs`
   * (default 60 s) passes, with the tail of its output.
   */
  findURL: (timeoutMs?: number) => Promise<string>;
  /** The port of `findURL`'s origin. */
  findPort: (timeoutMs?: number) => Promise<number>;
  readonly pid: number | undefined;
  stdout: () => string;
  stderr: () => string;
}

/** A server's printed origin: vite, `vite preview` and wrangler all print one. */
const ORIGIN_PATTERN = /http:\/\/(?:localhost|[\d.]+):(\d+)/;

/**
 * Spawn `options.command` (split on spaces) as the leader of its own process
 * group. `options.env` is laid over `process.env`; a key set to `undefined` is
 * left out of the child's environment.
 */
export function runCli(
  options: { command: string; label?: string } & SpawnOptions,
): RunCliHandle {
  const [name, ...args] = options.command.split(" ");
  // detached makes the child a process-group leader (pgid === pid), so kill()
  // can signal the whole tree. `pnpm dev` spawns vite as a grandchild; without
  // it process.kill(-pid) throws ESRCH, the fallback child.kill() stops only
  // pnpm, and vite keeps running after the suite. Not on Windows: there
  // detached opens a console window per server, and kill() already ends the
  // tree with `taskkill /t`.
  const child = x(name!, args, {
    nodeOptions: { ...options, detached: process.platform !== "win32" },
  }).process!;
  const label = `[${options.label ?? "cli"}]`;
  let stdout = "";
  let stderr = "";
  // Registered before any findURL listener, so a listener sees the output and
  // the exit it was called for.
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
  let exited: { code: number | null } | undefined;
  let resolveExitCode!: (code: number | null) => void;
  const exitCode = new Promise<number | null>((resolve) => {
    resolveExitCode = resolve;
  });
  const done = exitCode.then(() => {});
  child.on("exit", (code) => {
    exited = { code };
    // null: ended by a signal; 143: exited on SIGTERM. Both are a teardown.
    if (
      code !== null &&
      code !== 0 &&
      code !== 143 &&
      process.platform !== "win32"
    ) {
      console.log(styleText("magenta", label), `exit code ${code}`);
    }
    resolveExitCode(code);
  });

  function waitForOrigin(timeoutMs: number): Promise<RegExpExecArray> {
    return new Promise((resolve, reject) => {
      const settle = () => {
        clearTimeout(timer);
        child.stdout!.off("data", check);
        child.off("exit", check);
      };
      const fail = (reason: string) => {
        settle();
        reject(
          new Error(
            `${label} ${reason}.\nStdout (tail):\n${tailOutput(stdout)}\nStderr (tail):\n${tailOutput(stderr)}`,
          ),
        );
      };
      // Reads all the output so far, so an origin printed before the call, or
      // a process that exited before it, settles the wait at once.
      function check(): void {
        const match = ORIGIN_PATTERN.exec(stdout);
        if (match) {
          settle();
          resolve(match);
        } else if (exited) {
          fail(`exited (code ${exited.code}) before printing a URL`);
        }
      }
      const timer = setTimeout(
        () => fail(`printed no URL within ${timeoutMs} ms`),
        timeoutMs,
      );
      child.stdout!.on("data", check);
      child.on("exit", check);
      check();
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
    findURL: async (timeoutMs = 60_000) => (await waitForOrigin(timeoutMs))[0],
    findPort: async (timeoutMs = 60_000) =>
      Number((await waitForOrigin(timeoutMs))[1]),
    kill,
    get pid() {
      return child.pid;
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

/** How long `stopServers` waits for SIGTERM to take effect before SIGKILL. */
const STOP_WAIT_MS = 10_000;
/** How long `stopServers` waits for the SIGKILL to take effect. */
const KILL_WAIT_MS = 2_000;

/** Resolves true when every promise settled, false when the timer won. */
async function settledWithin(
  promises: Promise<unknown>[],
  ms: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([
      Promise.allSettled(promises).then(() => true as const),
      timedOut,
    ]);
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
 * Resolves true once every server's `done` settled and no process of any of
 * their groups is left, false when `ms` ran out first. The leader (`pnpm`)
 * exiting says nothing about the vite it spawned, which can outlive it, so the
 * groups are polled too.
 */
async function groupsExitedWithin(
  servers: readonly GuardedServer[],
  ms: number,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  if (
    !(await settledWithin(
      servers.map((s) => s.done),
      ms,
    ))
  )
    return false;
  const pgids = servers.flatMap((s) => (s.pid === undefined ? [] : [s.pid]));
  while (pgids.some(groupAlive)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

/**
 * Stop servers and wait for each whole process group to exit: SIGTERM to every
 * group, then SIGKILL (and one log naming the pids) for any that outlive
 * `exitWaitMs` (default 10 s), so a leaked server is visible rather than left
 * holding its port. A rejecting `done` counts as exited.
 */
export async function stopServers(
  servers: readonly GuardedServer[],
  options: { exitWaitMs?: number } = {},
): Promise<void> {
  const exitWaitMs = options.exitWaitMs ?? STOP_WAIT_MS;
  const exited = new Set<GuardedServer>();
  for (const server of servers) {
    const markExited = () => void exited.add(server);
    server.done.then(markExited, markExited);
    server.kill();
  }
  if (await groupsExitedWithin(servers, exitWaitMs)) return;
  // A leader that exited can still leave a live group (the vite `pnpm`
  // spawned), so a survivor is either.
  const survivors = servers.filter(
    (server) =>
      !exited.has(server) ||
      (server.pid !== undefined && groupAlive(server.pid)),
  );
  if (survivors.length === 0) return;
  for (const server of survivors) server.kill("SIGKILL");
  const pids = survivors.map((server) => server.pid ?? "unknown").join(", ");
  console.error(
    `[rango e2e] ${survivors.length} server(s) ignored SIGTERM for ` +
      `${exitWaitMs} ms and were sent SIGKILL (pid ${pids})`,
  );
  await groupsExitedWithin(survivors, KILL_WAIT_MS);
}

/**
 * Owns the child processes (dev/preview servers, builds) a fixture's
 * `beforeAll` starts, so a `beforeAll` that fails or times out cannot leave one
 * running.
 *
 * Why it exists: a fixture that assigns its `cleanup` only after the server
 * answered leaks the server when `beforeAll` misses its timeout (common under
 * load): `afterAll` has nothing to stop and the detached server keeps its port
 * and RAM after the run. Playwright also does not cancel a timed-out hook: its
 * body keeps running while `afterAll` runs, so a build that finishes after
 * teardown goes on to start a preview server nobody would stop. The guard
 * closes both holes: a server is tracked the moment it is spawned, and once
 * disposed it refuses (and kills) anything started later.
 */
export class ServerGuard {
  #tracked = new Set<GuardedServer>();
  #disposed = false;
  #exitWaitMs: number | undefined;

  /** `exitWaitMs`: how long `dispose()` waits before SIGKILL (default 10 s). */
  constructor(options: { exitWaitMs?: number } = {}) {
    this.#exitWaitMs = options.exitWaitMs;
  }

  // The methods are bound properties, not prototype methods, so a detached
  // call (`test.afterAll(servers.dispose)`, `procs.map(servers.track)`) still
  // reaches this guard's private state.

  /** Throws once the guard is disposed: the hook that owns it has ended. */
  readonly assertLive: () => void = () => {
    if (this.#disposed) {
      throw new Error(
        "The fixture was torn down while its server was still starting " +
          "(a beforeAll timeout?)",
      );
    }
  };

  /**
   * Register a server the moment it is spawned, before anything is awaited.
   * Spawned after dispose(), it is stopped on the spot (with the same SIGKILL
   * escalation as dispose()) and this throws.
   */
  readonly track: <T extends GuardedServer>(server: T) => T = (server) => {
    if (this.#disposed) {
      // Not awaited: the caller learns of the teardown from the throw below.
      // stopServers rejects only when a kill() throws, and that must not
      // surface as an unhandled rejection.
      stopServers([server], { exitWaitMs: this.#exitWaitMs }).catch(() => {});
      this.assertLive();
    }
    this.#tracked.add(server);
    // A rejecting done still means the process is gone, and must not surface
    // as an unhandled rejection from here.
    const forget = () => void this.#tracked.delete(server);
    server.done.then(forget, forget);
    return server;
  };

  /**
   * Stop every tracked server with `stopServers` and wait for them to exit.
   * Idempotent.
   */
  readonly dispose: () => Promise<void> = async () => {
    this.#disposed = true;
    await stopServers([...this.#tracked], { exitWaitMs: this.#exitWaitMs });
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
