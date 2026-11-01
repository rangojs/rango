/**
 * Owns the child processes (dev/preview servers, builds) a fixture's
 * `beforeAll` starts, so a `beforeAll` that fails or times out cannot leave one
 * running.
 *
 * Why it exists: the fixtures used to assign their `cleanup` only after the
 * server answered. A `beforeAll` that missed its timeout (common under load)
 * never reached that line, so `afterAll` had nothing to stop and the detached
 * server kept its port and RAM after the run. Playwright also does
 * not cancel a timed-out hook: its body keeps running while `afterAll` runs, so
 * a build that finishes after teardown went on to start a preview server nobody
 * would stop. The guard closes both holes: a server is tracked the moment it is
 * spawned, and once disposed it refuses (and kills) anything started later.
 */
export interface GuardedServer {
  /**
   * Stop the process and what it spawned (the whole process group). SIGTERM by
   * default; dispose() escalates to SIGKILL for a process that outlives the wait.
   */
  kill(signal?: NodeJS.Signals): void;
  /** Settles when the process has exited. Treated as possibly rejecting. */
  done: Promise<unknown>;
  /** Named in the log when the process survives dispose(). */
  pid?: number;
}

/** How long dispose() waits for the processes to exit before escalating. */
const DEFAULT_EXIT_WAIT_MS = 10_000;
/** How long dispose() waits for the SIGKILL to take effect. */
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
 * groups are polled too. Same shape as `stopServer` in
 * packages/rangojs-router/src/testing/e2e/server.ts, which this package cannot
 * import.
 */
async function groupsExitedWithin(
  servers: GuardedServer[],
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

export class ServerGuard {
  #tracked = new Set<GuardedServer>();
  #disposed = false;
  #exitWaitMs: number;

  constructor(options: { exitWaitMs?: number } = {}) {
    this.#exitWaitMs = options.exitWaitMs ?? DEFAULT_EXIT_WAIT_MS;
  }

  /** Throws once the guard is disposed: the hook that owns it has ended. */
  assertLive(): void {
    if (this.#disposed) {
      throw new Error(
        "The fixture was torn down while its server was still starting " +
          "(a beforeAll timeout?)",
      );
    }
  }

  /**
   * Register a server the moment it is spawned, before anything is awaited.
   * Spawned after dispose(), it is killed on the spot and this throws.
   */
  track<T extends GuardedServer>(server: T): T {
    this.#tracked.add(server);
    // A rejecting done still means the process is gone, and must not surface
    // as an unhandled rejection from here.
    const forget = () => void this.#tracked.delete(server);
    server.done.then(forget, forget);
    if (this.#disposed) {
      server.kill();
      this.assertLive();
    }
    return server;
  }

  /**
   * Stop every tracked server and wait for them to exit. Idempotent. A server
   * still alive after the wait is sent SIGKILL and its pid logged, so a leak
   * is visible rather than silent.
   */
  async dispose(): Promise<void> {
    this.#disposed = true;
    const servers = [...this.#tracked];
    for (const server of servers) server.kill();
    if (await groupsExitedWithin(servers, this.#exitWaitMs)) return;
    // A server whose leader exited can still hold a live group, so survivors
    // are not only the ones whose `done` is pending: forget() has already
    // dropped those, and they are exactly the ones this must still signal.
    const survivors = servers.filter(
      (server) =>
        this.#tracked.has(server) ||
        (server.pid !== undefined && groupAlive(server.pid)),
    );
    for (const server of survivors) server.kill("SIGKILL");
    const pids = survivors.map((server) => server.pid ?? "unknown").join(", ");
    console.error(
      `[server-guard] ${survivors.length} server(s) ignored SIGTERM for ` +
        `${this.#exitWaitMs} ms and were sent SIGKILL (pid ${pids})`,
    );
    await groupsExitedWithin(survivors, KILL_WAIT_MS);
  }
}
