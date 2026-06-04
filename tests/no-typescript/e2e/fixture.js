import { spawn } from "node:child_process";
import path from "node:path";
import { stripVTControlCharacters, styleText } from "node:util";
import test from "@playwright/test";
import { x } from "tinyexec";
import { waitForServer } from "./helper.js";

function runCli(options) {
  const [name, ...args] = options.command.split(" ");
  // detached so we can signal the whole process group on teardown (pnpm spawns
  // vite as a grandchild that would otherwise survive a direct child.kill()).
  const child = x(name, args, {
    nodeOptions: {
      ...options,
      detached: true,
      // Force the server to bind a concrete IPv4 host so the printed origin is
      // unambiguous (no `localhost` -> IPv4/IPv6 mismatch with another listener
      // on the same port). Harmless for the non-server `pnpm build` spawn.
      env: { ...process.env, ...options.env, RANGO_NOTS_HOST: "127.0.0.1" },
    },
  }).process;
  const label = `[${options.label ?? "cli"}]`;
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => {
    stdout += stripVTControlCharacters(String(data));
    if (process.env.TEST_DEBUG) {
      console.log(styleText("cyan", label), data.toString());
    }
  });
  child.stderr.on("data", (data) => {
    stderr += stripVTControlCharacters(String(data));
    if (process.env.TEST_DEBUG) {
      console.log(styleText("magenta", label), data.toString());
    }
  });
  const done = new Promise((resolve) => {
    child.on("exit", (code) => {
      // null = killed by signal (normal teardown), 0 = success, 143 = SIGTERM.
      if (
        code !== null &&
        code !== 0 &&
        code !== 143 &&
        process.platform !== "win32"
      ) {
        console.log(styleText("magenta", `${label}`), `exit code ${code}`);
      }
      resolve();
    });
  });

  async function findURL() {
    let buffered = "";
    return new Promise((resolve, reject) => {
      // Fail fast if the server never prints a URL (crash on startup, port in
      // use, missing dist) instead of hanging beforeAll until globalTimeout.
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `${label} timed out waiting for server to start.\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
          ),
        );
      }, 60000);
      const onExit = (code) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `${label} exited (code ${code}) before printing a URL.\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
          ),
        );
      };
      child.once("exit", onExit);
      child.stdout.on("data", (data) => {
        buffered += stripVTControlCharacters(String(data));
        // Capture the full printed origin and use it verbatim. The server is
        // forced to bind 127.0.0.1, so this is a concrete IPv4 address rather
        // than `localhost` (which could resolve to a different IPv4/IPv6
        // listener than the one the server bound).
        const match = buffered.match(/(http:\/\/[^/\s]+)/);
        if (match) {
          clearTimeout(timeout);
          child.off("exit", onExit);
          resolve(match[1]);
        }
      });
    });
  }

  function kill() {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
    } else {
      // Signal the whole process group so the vite grandchild dies too.
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already dead.
          }
        }
      }, 2000);
    }
  }

  return {
    proc: child,
    done,
    findURL,
    kill,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

export function useFixture(options) {
  let cleanup;
  let baseURL;

  const cwd = path.resolve(options.root);
  let proc;

  test.beforeAll(async ({}, testInfo) => {
    if (options.mode === "dev") {
      proc = runCli({
        command: options.command ?? `pnpm dev`,
        label: `${options.root}:dev`,
        cwd,
        ...options.cliOptions,
      });
      baseURL = await proc.findURL();
      cleanup = async () => {
        proc.kill();
        await proc.done;
      };
      // "Port printed" != "ready to serve" for vite dev: settle two consecutive
      // OK responses to absorb the first-request dep-optimizer cycle.
      await waitForServer(`${baseURL}/`, {
        settleOks: 2,
        getOutput: () => ({ stdout: proc.stdout(), stderr: proc.stderr() }),
      });
    }
    if (options.mode === "build") {
      const hasBuildDep = testInfo.project.dependencies.includes("build");
      if (!process.env.TEST_SKIP_BUILD && !hasBuildDep) {
        const buildProc = runCli({
          command: options.buildCommand ?? `pnpm build`,
          label: `${options.root}:build`,
          cwd,
          ...options.cliOptions,
        });
        await buildProc.done;
      }
      proc = runCli({
        command: options.command ?? `pnpm preview`,
        label: `${options.root}:preview`,
        cwd,
        ...options.cliOptions,
      });
      baseURL = await proc.findURL();
      cleanup = async () => {
        proc.kill();
        await proc.done;
      };
      // Preview serves static dist (no optimizer), but still confirm it is
      // actually serving before tests navigate.
      await waitForServer(`${baseURL}/`, {
        getOutput: () => ({ stdout: proc.stdout(), stderr: proc.stderr() }),
      });
    }
  });

  test.afterAll(async () => {
    await cleanup?.();
  });

  return {
    mode: options.mode,
    root: cwd,
    url: (url = "./") => new URL(url, baseURL).href,
    proc: () => proc,
  };
}
