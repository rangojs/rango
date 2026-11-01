import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli, stopServer } from "../e2e/server.js";

/**
 * The consumer fixture starts `pnpm dev` / `pnpm preview`, which spawn vite as
 * a grandchild. Stopping only the direct child leaves vite running after the
 * suite, so these tests spawn a parent with a grandchild and
 * check that stopServer reaches both. Process groups are POSIX-only; on Windows
 * the harness ends the tree with `taskkill /t`.
 */

let dir: string;
/** Handles started by a test, so afterEach reaps what a failure leaves. */
const started: Array<ReturnType<typeof runCli>> = [];
/** Grandchild pids, killed directly in case a failure left them out of the group. */
const grandchildren: number[] = [];

/**
 * A server stand-in: spawns a grandchild, prints its pid with a URL once the
 * grandchild has installed its signal handling, then stays alive. The
 * grandchild is not detached, so it shares the parent's process group, as vite
 * shares pnpm's. `parentIgnoresSigterm` / `grandchildIgnoresSigterm` make that
 * process survive SIGTERM, so only SIGKILL stops it.
 */
function writeServerScript(options: {
  parentIgnoresSigterm: boolean;
  grandchildIgnoresSigterm: boolean;
}): void {
  const grandchildSource = [
    options.grandchildIgnoresSigterm ? "process.on('SIGTERM', () => {});" : "",
    "console.log('ready');",
    "setInterval(() => {}, 1000);",
  ].join("");
  writeFileSync(
    path.join(dir, "server.mjs"),
    [
      `import { spawn } from "node:child_process";`,
      options.parentIgnoresSigterm ? "process.on('SIGTERM', () => {});" : "",
      `const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}], { stdio: ["ignore", "pipe", "ignore"] });`,
      // The URL line is what findPort waits for; print it only once the
      // grandchild's SIGTERM handling is in place, so a test that expects it to
      // survive SIGTERM does not race its startup.
      `grandchild.stdout.once("data", () => console.log("http://localhost:1234 grandchild=" + grandchild.pid));`,
      `setInterval(() => {}, 1000);`,
    ].join("\n"),
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

async function startServer(options: {
  parentIgnoresSigterm: boolean;
  grandchildIgnoresSigterm: boolean;
}) {
  writeServerScript(options);
  const server = runCli({
    // Run from `dir` with node on PATH, so no token of the command holds a
    // path that could contain a space (runCli splits the command on spaces).
    command: "node server.mjs",
    label: "e2e-server-test",
    cwd: dir,
    env: {
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
  started.push(server);
  await server.findPort(10_000);
  const grandchild = Number(/grandchild=(\d+)/.exec(server.stdout())?.[1]);
  expect(grandchild).toBeGreaterThan(0);
  grandchildren.push(grandchild);
  expect(isAlive(grandchild)).toBe(true);
  return { server, grandchild };
}

describe.skipIf(process.platform === "win32")("stopServer", () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "rango-e2e-server-"));
  });

  afterEach(() => {
    for (const server of started.splice(0)) {
      try {
        process.kill(-server.pid!, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    for (const pid of grandchildren.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("stops the process and what it spawned", async () => {
    const { server, grandchild } = await startServer({
      parentIgnoresSigterm: false,
      grandchildIgnoresSigterm: false,
    });

    await stopServer(server);

    expect(isAlive(server.pid!)).toBe(false);
    expect(await waitUntil(() => !isAlive(grandchild))).toBe(true);
  });

  it("sends SIGKILL to a server that ignores SIGTERM and names its pid", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { server, grandchild } = await startServer({
      parentIgnoresSigterm: true,
      grandchildIgnoresSigterm: true,
    });

    await stopServer(server, { exitWaitMs: 300 });

    expect(isAlive(server.pid!)).toBe(false);
    expect(await waitUntil(() => !isAlive(grandchild))).toBe(true);
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining(`pid ${server.pid}`),
    );
  });

  it("waits for the whole group: SIGKILLs a grandchild that outlives a parent that exited on SIGTERM", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { server, grandchild } = await startServer({
      parentIgnoresSigterm: false,
      grandchildIgnoresSigterm: true,
    });

    await stopServer(server, { exitWaitMs: 300 });

    // No waitUntil: stopServer returning is the contract, so a grandchild
    // still alive here is a leaked server.
    expect(isAlive(grandchild)).toBe(false);
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining(`pid ${server.pid}`),
    );
  });
});
