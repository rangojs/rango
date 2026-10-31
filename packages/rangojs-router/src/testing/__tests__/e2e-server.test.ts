import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli, stopServer } from "../e2e/server.js";

/**
 * The consumer fixture starts `pnpm dev` / `pnpm preview`, which spawn vite as
 * a grandchild. Stopping only the direct child leaves vite running after the
 * suite (rango-t245), so these tests spawn a parent with a grandchild and
 * check that stopServer reaches both.
 */

let dir: string;
/** Handles started by a test, so afterEach reaps what a failure leaves. */
const started: Array<ReturnType<typeof runCli>> = [];

/**
 * A server stand-in: spawns a grandchild in its own group (as pnpm spawns
 * vite), prints its pid with a URL, then stays alive. `ignoreSigterm` makes
 * both ignore SIGTERM, so only SIGKILL stops them.
 */
function writeServerScript(options: { ignoreSigterm: boolean }): string {
  const ignore = options.ignoreSigterm
    ? "process.on('SIGTERM', () => {});"
    : "";
  const grandchildSource = `${ignore}setInterval(() => {}, 1000)`;
  const file = path.join(dir, "server.mjs");
  writeFileSync(
    file,
    [
      `import { spawn } from "node:child_process";`,
      ignore,
      `const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}], { stdio: "ignore" });`,
      `console.log("http://localhost:1234 grandchild=" + grandchild.pid);`,
      `setInterval(() => {}, 1000);`,
    ].join("\n"),
  );
  return file;
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

async function startServer(script: string) {
  const server = runCli({
    command: `${process.execPath} ${script}`,
    label: "e2e-server-test",
  });
  started.push(server);
  await server.findPort(10_000);
  const grandchild = Number(/grandchild=(\d+)/.exec(server.stdout())?.[1]);
  expect(grandchild).toBeGreaterThan(0);
  expect(isAlive(grandchild)).toBe(true);
  return { server, grandchild };
}

describe("stopServer", () => {
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
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("stops the process and what it spawned", async () => {
    const { server, grandchild } = await startServer(
      writeServerScript({ ignoreSigterm: false }),
    );

    await stopServer(server);

    expect(isAlive(server.pid!)).toBe(false);
    expect(await waitUntil(() => !isAlive(grandchild))).toBe(true);
  });

  it("sends SIGKILL to a server that ignores SIGTERM and names its pid", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { server, grandchild } = await startServer(
      writeServerScript({ ignoreSigterm: true }),
    );

    await stopServer(server, { exitWaitMs: 300 });

    expect(isAlive(server.pid!)).toBe(false);
    expect(await waitUntil(() => !isAlive(grandchild))).toBe(true);
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining(`pid ${server.pid}`),
    );
  });
});
