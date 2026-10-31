import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerGuard, type GuardedServer } from "./server-guard.js";

/** Every pid spawned by a test, so afterEach can reap what a failure leaves. */
const spawned: number[] = [];

/**
 * A detached node process that stays alive until it is killed. With
 * `ignoreSigterm` it survives SIGTERM, so only SIGKILL stops it.
 */
function spawnIdleServer(
  options: { ignoreSigterm?: boolean } = {},
): GuardedServer & { pid: number } {
  const script =
    (options.ignoreSigterm ? "process.on('SIGTERM', () => {});" : "") +
    "setInterval(() => {}, 1000)";
  const child = spawn(process.execPath, ["-e", script], {
    detached: true,
    stdio: "ignore",
  });
  spawned.push(child.pid!);
  const done = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  return {
    pid: child.pid!,
    done,
    // The whole group, as the fixtures' runCli().kill() does.
    kill: (signal = "SIGTERM") => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        child.kill(signal);
      }
    },
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// dispose() waits up to its exit wait (10 s by default) before escalating, which
// is longer than vitest's 5 s default: without this a failing assertion would
// surface as a timeout instead.
describe("ServerGuard", { timeout: 20_000 }, () => {
  afterEach(() => {
    for (const pid of spawned.splice(0)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    vi.restoreAllMocks();
  });

  it("dispose stops a server that never became ready", async () => {
    const guard = new ServerGuard();
    // Tracked at spawn, as a beforeAll does before it awaits readiness.
    const server = guard.track(spawnIdleServer());
    expect(isAlive(server.pid)).toBe(true);

    await guard.dispose();

    expect(isAlive(server.pid)).toBe(false);
  });

  it("dispose stops every tracked server, a build and a preview alike", async () => {
    const guard = new ServerGuard();
    const first = guard.track(spawnIdleServer());
    const second = guard.track(spawnIdleServer());

    await guard.dispose();

    expect(isAlive(first.pid)).toBe(false);
    expect(isAlive(second.pid)).toBe(false);
  });

  it("kills and refuses a server tracked after dispose (a timed-out hook that kept going)", async () => {
    const guard = new ServerGuard();
    await guard.dispose();

    const late = spawnIdleServer();
    expect(() => guard.track(late)).toThrow(/torn down/);
    await late.done;

    expect(isAlive(late.pid)).toBe(false);
  });

  it("assertLive passes until dispose, then throws", async () => {
    const guard = new ServerGuard();
    expect(() => guard.assertLive()).not.toThrow();
    await guard.dispose();
    expect(() => guard.assertLive()).toThrow(/torn down/);
  });

  it("dispose is idempotent and leaves exited servers alone", async () => {
    const guard = new ServerGuard();
    const server = guard.track(spawnIdleServer());
    server.kill();
    await server.done;

    await guard.dispose();
    await guard.dispose();

    expect(isAlive(server.pid)).toBe(false);
  });

  it("dispose sends SIGKILL to a server that ignores SIGTERM and logs its pid", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const guard = new ServerGuard({ exitWaitMs: 300 });
    const stubborn = guard.track(spawnIdleServer({ ignoreSigterm: true }));
    // Let the child install its SIGTERM handler before the guard signals it.
    await new Promise((resolve) => setTimeout(resolve, 500));

    await guard.dispose();

    expect(isAlive(stubborn.pid)).toBe(false);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(String(stubborn.pid)),
    );
  });

  it("a rejecting done neither throws from dispose nor leaves an unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const guard = new ServerGuard();
      const server = spawnIdleServer();
      const rejecting: GuardedServer = {
        ...server,
        done: server.done.then(() => {
          throw new Error("done rejected");
        }),
      };
      guard.track(rejecting);

      await expect(guard.dispose()).resolves.toBeUndefined();
      // Give a stray rejection time to be reported.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(isAlive(server.pid)).toBe(false);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
