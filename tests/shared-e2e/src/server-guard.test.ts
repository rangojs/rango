import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ServerGuard, type GuardedServer } from "./server-guard.js";

/** A detached node process that stays alive until it is killed. */
function spawnIdleServer(): GuardedServer & { pid: number } {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  const done = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  return {
    pid: child.pid!,
    done,
    // The whole group, as the fixtures' runCli().kill() does.
    kill: () => {
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        child.kill();
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

describe("ServerGuard", () => {
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
});
