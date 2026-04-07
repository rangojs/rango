import { execSync, spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { x } from "tinyexec";

export interface Server {
  port: number;
  pid: number;
  kill: () => Promise<void>;
}

/**
 * Get total RSS in KB for a process group.
 * On macOS, sums RSS for all processes sharing the PGID.
 * On Linux, uses pgrep -g to find group members.
 */
export function getGroupRssKb(pid: number): number {
  try {
    if (process.platform === "darwin") {
      const out = execSync("ps -axo pid=,pgid=,rss=", {
        encoding: "utf-8",
      });
      const pgid = String(pid);
      return out
        .trim()
        .split("\n")
        .reduce((sum, line) => {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 3 && parts[1] === pgid) {
            return sum + (parseInt(parts[2], 10) || 0);
          }
          return sum;
        }, 0);
    } else {
      const pidsRaw = execSync(`pgrep -g ${pid}`, {
        encoding: "utf-8",
      }).trim();
      if (!pidsRaw) return 0;
      const pidList = pidsRaw.split("\n").join(",");
      const out = execSync(`ps -o rss= -p ${pidList}`, {
        encoding: "utf-8",
      });
      return out
        .trim()
        .split("\n")
        .reduce((sum, line) => sum + (parseInt(line.trim(), 10) || 0), 0);
    }
  } catch {
    return 0;
  }
}

/**
 * Start polling RSS for a process group. Returns a handle to stop and read results.
 */
export function startRssPolling(
  pid: number,
  intervalMs = 500,
): { stop: () => { peakRssKb: number; finalRssKb: number } } {
  let peakRssKb = 0;
  let finalRssKb = 0;

  const interval = setInterval(() => {
    const rss = getGroupRssKb(pid);
    if (rss > peakRssKb) peakRssKb = rss;
    finalRssKb = rss;
  }, intervalMs);

  return {
    stop() {
      clearInterval(interval);
      // One final sample
      const rss = getGroupRssKb(pid);
      if (rss > peakRssKb) peakRssKb = rss;
      finalRssKb = rss;
      return { peakRssKb, finalRssKb };
    },
  };
}

function spawnServer(command: string, cwd: string, label: string) {
  const [name, ...args] = command.split(" ");
  const child = x(name!, args, {
    nodeOptions: { cwd, detached: true },
  }).process!;

  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (data) => {
    stdout += stripVTControlCharacters(String(data));
  });
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
  const srv = spawnServer("pnpm dev", cwd, "dev");
  const port = await srv.findPort();
  await waitForReady(`http://localhost:${port}/json-api/health`);
  return { port, pid: srv.pid, kill: srv.kill };
}

export async function startProdServer(cwd: string): Promise<Server> {
  const srv = spawnServer("pnpm wrangler dev --port 0", cwd, "prod");
  const port = await srv.findPort();
  await waitForReady(`http://localhost:${port}/json-api/health`);
  return { port, pid: srv.pid, kill: srv.kill };
}
