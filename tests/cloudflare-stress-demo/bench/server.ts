import { execSync, spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { x } from "tinyexec";

export interface Server {
  port: number;
  pid: number;
  command: string;
  kill: () => Promise<void>;
}

interface GroupRss {
  totalKb: number;
  workerdKb: number;
}

/**
 * Total RSS in KB for a process group, plus the workerd-only subset.
 * This is toolchain RSS (node/vite/wrangler + workerd), NOT isolate heap —
 * label it accordingly wherever it is reported.
 */
export function getGroupRss(pid: number): GroupRss {
  try {
    if (process.platform === "darwin") {
      const out = execSync("ps -axo pid=,pgid=,rss=,comm=", {
        encoding: "utf-8",
      });
      const pgid = String(pid);
      let totalKb = 0;
      let workerdKb = 0;
      for (const line of out.trim().split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4 || parts[1] !== pgid) continue;
        const rss = parseInt(parts[2]!, 10) || 0;
        totalKb += rss;
        if (parts.slice(3).join(" ").includes("workerd")) workerdKb += rss;
      }
      return { totalKb, workerdKb };
    } else {
      const pidsRaw = execSync(`pgrep -g ${pid}`, {
        encoding: "utf-8",
      }).trim();
      if (!pidsRaw) return { totalKb: 0, workerdKb: 0 };
      const pidList = pidsRaw.split("\n").join(",");
      const out = execSync(`ps -o rss=,comm= -p ${pidList}`, {
        encoding: "utf-8",
      });
      let totalKb = 0;
      let workerdKb = 0;
      for (const line of out.trim().split("\n")) {
        const parts = line.trim().split(/\s+/);
        const rss = parseInt(parts[0]!, 10) || 0;
        totalKb += rss;
        if (parts.slice(1).join(" ").includes("workerd")) workerdKb += rss;
      }
      return { totalKb, workerdKb };
    }
  } catch {
    return { totalKb: 0, workerdKb: 0 };
  }
}

export function getGroupRssKb(pid: number): number {
  return getGroupRss(pid).totalKb;
}

/**
 * Poll RSS for a process group. Returns a handle to stop and read results.
 * The default interval is deliberately coarse: each poll execSyncs a full
 * `ps -axo` scan on the same host that runs the load generator, so tight
 * polling would contend with the measurement it serves.
 */
export function startRssPolling(
  pid: number,
  intervalMs = 1500,
): {
  stop: () => { peakRssKb: number; finalRssKb: number; peakWorkerdKb: number };
} {
  let peakRssKb = 0;
  let finalRssKb = 0;
  let peakWorkerdKb = 0;

  const interval = setInterval(() => {
    const rss = getGroupRss(pid);
    if (rss.totalKb > peakRssKb) peakRssKb = rss.totalKb;
    if (rss.workerdKb > peakWorkerdKb) peakWorkerdKb = rss.workerdKb;
    finalRssKb = rss.totalKb;
  }, intervalMs);

  return {
    stop() {
      clearInterval(interval);
      const rss = getGroupRss(pid);
      if (rss.totalKb > peakRssKb) peakRssKb = rss.totalKb;
      if (rss.workerdKb > peakWorkerdKb) peakWorkerdKb = rss.workerdKb;
      finalRssKb = rss.totalKb;
      return { peakRssKb, finalRssKb, peakWorkerdKb };
    },
  };
}

/**
 * Resolve a command to the app's local binary so the harness does not depend
 * on the pnpm wrapper (verifyDepsBeforeRun breaks `pnpm <script>` locally).
 */
export function binPath(cwd: string, name: string): string {
  return path.join(cwd, "node_modules", ".bin", name);
}

function spawnServer(command: string[], cwd: string, label: string) {
  const [name, ...args] = command;
  const child = x(name!, args, {
    nodeOptions: { cwd, detached: true },
  }).process!;

  // Only stderr is accumulated (for error reporting): wrangler logs every
  // request to stdout, so an unbounded stdout accumulator grows toward tens
  // of MB across a long bench and is read by nothing — findPort keeps its
  // own bounded buffer until the port appears.
  let stderr = "";
  child.stderr!.on("data", (data) => {
    stderr += stripVTControlCharacters(String(data));
  });

  const done = new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
  });

  async function findPort(): Promise<number> {
    let output = "";
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `[${label}] Timeout waiting for server after 60s.\nStdout: ${output}`,
          ),
        );
      }, 60000);

      child.stdout!.on("data", (data) => {
        output += stripVTControlCharacters(String(data));
        const match = output.match(/http:\/\/(?:localhost|[\d.]+):(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(Number(match[1]));
        }
      });

      child.on("exit", (code) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `[${label}] Server exited with code ${code}.\nStdout: ${output}\nStderr: ${stderr}`,
          ),
        );
      });
    });
  }

  function kill(): Promise<void> {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
    } else {
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already dead
          }
        }
      }, 2000);
    }
    return done;
  }

  return { pid: child.pid!, findPort, kill };
}

/**
 * Wait for the TCP port to accept connections WITHOUT sending an HTTP request
 * — cold-start measurement must not warm the worker before the first
 * measured request.
 */
export async function waitForPortOpen(
  port: number,
  timeoutMs = 30000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host: "127.0.0.1" });
      const fail = () => {
        socket.destroy();
        resolve(false);
      };
      socket.once("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.once("error", fail);
      socket.setTimeout(500, fail);
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `Port ${port} not accepting connections after ${timeoutMs}ms`,
  );
}

async function waitForReady(url: string, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server not ready after ${timeoutMs}ms: ${url}`);
}

export async function startDevServer(cwd: string): Promise<Server> {
  const command = [binPath(cwd, "vite"), "dev"];
  const srv = spawnServer(command, cwd, "dev");
  const port = await srv.findPort();
  await waitForReady(`http://localhost:${port}/json-api/health`);
  return { port, pid: srv.pid, command: command.join(" "), kill: srv.kill };
}

export interface ProdServerOptions {
  /**
   * When true, readiness is TCP-level only: no HTTP request is sent, so the
   * caller's first fetch is the worker's genuine first request (cold start).
   */
  cold?: boolean;
}

export async function startProdServer(
  cwd: string,
  options: ProdServerOptions = {},
): Promise<Server> {
  const command = [binPath(cwd, "wrangler"), "dev", "--port", "0"];
  const srv = spawnServer(command, cwd, "prod");
  const port = await srv.findPort();
  if (options.cold) {
    await waitForPortOpen(port);
  } else {
    await waitForReady(`http://localhost:${port}/json-api/health`);
  }
  return { port, pid: srv.pid, command: command.join(" "), kill: srv.kill };
}
