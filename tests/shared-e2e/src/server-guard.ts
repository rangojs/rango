/**
 * Owns the child processes (dev/preview servers, builds) a fixture's
 * `beforeAll` starts, so a `beforeAll` that fails or times out cannot leave one
 * running.
 *
 * Why it exists: the fixtures used to assign their `cleanup` only after the
 * server answered. A `beforeAll` that missed its timeout (common under load)
 * never reached that line, so `afterAll` had nothing to stop and the detached
 * server kept its port and RAM after the run (rango-t206). Playwright also does
 * not cancel a timed-out hook: its body keeps running while `afterAll` runs, so
 * a build that finishes after teardown went on to start a preview server nobody
 * would stop. The guard closes both holes: a server is tracked the moment it is
 * spawned, and once disposed it refuses (and kills) anything started later.
 */
export interface GuardedServer {
  /** Stop the process and what it spawned (the whole process group). */
  kill(): void;
  /** Settles when the process has exited. */
  done: Promise<unknown>;
}

/** How long dispose() waits for the processes to exit before giving up. */
const EXIT_WAIT_MS = 10_000;

export class ServerGuard {
  #tracked = new Set<GuardedServer>();
  #disposed = false;

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
    server.done.then(() => this.#tracked.delete(server));
    if (this.#disposed) {
      server.kill();
      this.assertLive();
    }
    return server;
  }

  /** Stop every tracked server and wait for them to exit. Idempotent. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    const servers = [...this.#tracked];
    for (const server of servers) server.kill();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(servers.map((server) => server.done)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, EXIT_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }
}
