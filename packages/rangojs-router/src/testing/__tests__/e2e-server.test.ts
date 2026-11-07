import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli, stopServers } from "../e2e/server.js";

/**
 * The consumer fixture starts `pnpm dev` / `pnpm preview`, which spawn vite as
 * a grandchild. Stopping only the direct child leaves vite running after the
 * suite, so these tests spawn a parent with a grandchild and
 * check that stopServers reaches both. Process groups are POSIX-only; on Windows
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

describe.skipIf(process.platform === "win32")("stopServers", () => {
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

    await stopServers([server]);

    expect(isAlive(server.pid!)).toBe(false);
    expect(await waitUntil(() => !isAlive(grandchild))).toBe(true);
  });

  it("sends SIGKILL to a server that ignores SIGTERM and names its pid", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { server, grandchild } = await startServer({
      parentIgnoresSigterm: true,
      grandchildIgnoresSigterm: true,
    });

    await stopServers([server], { exitWaitMs: 300 });

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

    await stopServers([server], { exitWaitMs: 300 });

    // No waitUntil: stopServers returning is the contract, so a grandchild
    // still alive here is a leaked server.
    expect(isAlive(grandchild)).toBe(false);
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining(`pid ${server.pid}`),
    );
  });
});

describe.skipIf(process.platform === "win32")("runCli", () => {
  const handles: Array<ReturnType<typeof runCli>> = [];

  /** Runs `source` with node; `env` is passed through as runCli's. */
  function runNode(
    source: string,
    env: NodeJS.ProcessEnv = {},
  ): ReturnType<typeof runCli> {
    const scriptDir = mkdtempSync(path.join(tmpdir(), "rango-run-cli-"));
    writeFileSync(path.join(scriptDir, "main.mjs"), source);
    const handle = runCli({
      command: "node main.mjs",
      label: "run-cli-test",
      cwd: scriptDir,
      env: {
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
        ...env,
      },
    });
    handles.push(handle);
    void handle.done.then(() =>
      rmSync(scriptDir, { recursive: true, force: true }),
    );
    return handle;
  }

  afterEach(async () => {
    await stopServers(handles.splice(0), { exitWaitMs: 1000 });
  });

  it("findURL and findPort read output printed before they were called", async () => {
    const handle = runNode(
      "console.log('Ready on http://127.0.0.1:8787'); setInterval(() => {}, 1000);",
    );
    await new Promise<void>((resolve) => {
      const poll = () =>
        handle.stdout().includes("Ready") ? resolve() : setTimeout(poll, 20);
      poll();
    });

    expect(await handle.findURL(1000)).toBe("http://127.0.0.1:8787");
    expect(await handle.findPort(1000)).toBe(8787);
  });

  it("findPort rejects when the process exits before printing a URL, even with code 0", async () => {
    const handle = runNode("console.error('port in use');");

    await expect(handle.findPort(5000)).rejects.toThrow(
      /exited \(code 0\) before printing a URL[\s\S]*Stderr \(tail\)/,
    );
    // Called after the exit, it still settles at once rather than at its timeout.
    await expect(handle.findURL(60_000)).rejects.toThrow(/exited \(code 0\)/);
  });

  it("findURL rejects after its timeout when no URL is printed", async () => {
    const handle = runNode("setInterval(() => {}, 1000);");

    await expect(handle.findURL(200)).rejects.toThrow(
      /printed no URL within 200 ms/,
    );
  });

  it("lays env over process.env and leaves out a key set to undefined", async () => {
    process.env.RANGO_RUN_CLI_INHERITED = "inherited";
    process.env.RANGO_RUN_CLI_REMOVED = "present";
    try {
      const handle = runNode(
        "console.log(JSON.stringify([process.env.RANGO_RUN_CLI_INHERITED, process.env.RANGO_RUN_CLI_SET, 'RANGO_RUN_CLI_REMOVED' in process.env]));",
        { RANGO_RUN_CLI_SET: "set", RANGO_RUN_CLI_REMOVED: undefined },
      );
      expect(await handle.exitCode).toBe(0);
      expect(JSON.parse(handle.stdout())).toEqual(["inherited", "set", false]);
    } finally {
      delete process.env.RANGO_RUN_CLI_INHERITED;
      delete process.env.RANGO_RUN_CLI_REMOVED;
    }
  });
});
