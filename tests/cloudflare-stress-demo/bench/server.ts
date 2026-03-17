import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { x } from "tinyexec";

interface Server {
  port: number;
  kill: () => Promise<void>;
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

  return { findPort, kill };
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
  return { port, kill: srv.kill };
}

export async function startProdServer(cwd: string): Promise<Server> {
  const srv = spawnServer("pnpm wrangler dev --port 0", cwd, "prod");
  const port = await srv.findPort();
  await waitForReady(`http://localhost:${port}/json-api/health`);
  return { port, kill: srv.kill };
}
