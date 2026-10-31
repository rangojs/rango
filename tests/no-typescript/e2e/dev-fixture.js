import { stripVTControlCharacters, styleText } from "node:util";
import { test as base, expect } from "@playwright/test";
import { assertFixtureModeMatchesProject, ServerGuard } from "@shared/e2e";
import { x } from "tinyexec";
import { waitForServer } from "./helper.js";

// Worker-scoped dev server: one `vite dev` per Playwright worker, shared by all
// dev tests on that worker.
export const test = base.extend({
  devServerURL: [
    async ({}, use, workerInfo) => {
      // A dev server serves the dev project only; a "(production)" describe
      // written with devTest would run against it in the production project.
      assertFixtureModeMatchesProject("dev", {
        titlePath: base.info().titlePath,
        project: workerInfo.project,
      });
      // detached so teardown can signal the whole process group (pnpm spawns
      // vite as a grandchild). Each Playwright worker gets an isolated Vite
      // cache dir so concurrent dev servers don't race on the shared
      // node_modules/.vite optimizer temp dirs (ENOTEMPTY on first optimize).
      const cacheDir = `node_modules/.vite-dev-${process.env.TEST_PARALLEL_INDEX ?? process.pid}`;
      const child = x("pnpm", ["dev"], {
        nodeOptions: {
          cwd: process.cwd(),
          detached: true,
          env: {
            ...process.env,
            RANGO_NOTS_VITE_CACHE_DIR: cacheDir,
            // Bind a concrete IPv4 host so the printed origin is unambiguous
            // (avoids `localhost` resolving to a different IPv4/IPv6 listener
            // than the one this server bound when a port collides cross-stack).
            RANGO_NOTS_HOST: "127.0.0.1",
          },
        },
      }).process;
      const servers = new ServerGuard();
      // Tracked as soon as it is spawned, before anything is awaited.
      servers.track({
        pid: child.pid,
        done: new Promise((resolve) => {
          child.once("exit", () => resolve());
        }),
        kill: (signal = "SIGTERM") => {
          try {
            process.kill(-child.pid, signal);
          } catch {
            child.kill(signal);
          }
        },
      });

      const label = "[.:dev]";
      let stdout = "";
      let stderr = "";

      const urlPromise = new Promise((resolve, reject) => {
        // Fail fast if dev never boots instead of hanging until globalTimeout.
        const timeout = setTimeout(() => {
          reject(
            new Error(
              `${label} timed out waiting for dev server to start.\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
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
          const str = String(data);
          stdout += stripVTControlCharacters(str);
          if (process.env.TEST_DEBUG) {
            console.log(styleText("cyan", label), str);
          }
          // Capture the full printed origin (host:port) and use it verbatim,
          // not just the port. The server is forced to bind 127.0.0.1, so the
          // origin is a concrete IPv4 address rather than `localhost` — which
          // could resolve to a different listener (IPv4 vs IPv6) than the one
          // the server actually bound.
          const match = stdout.match(/(http:\/\/[^/\s]+)/);
          if (match) {
            clearTimeout(timeout);
            child.off("exit", onExit);
            resolve(match[1]);
          }
        });
      });

      child.stderr.on("data", (data) => {
        stderr += stripVTControlCharacters(String(data));
        if (process.env.TEST_DEBUG) {
          console.log(styleText("magenta", label), data.toString());
        }
      });

      // The guard stops the whole process group (the vite grandchild too) when
      // the fixture ends or fails anywhere below, a startup timeout included.
      try {
        const baseURL = await urlPromise;
        // "Port printed" != "ready to serve": wait for two consecutive OK
        // responses so the first SSR request's dep-optimizer cycle is absorbed
        // before any test navigates (otherwise the first nav can ERR_EMPTY_RESPONSE).
        await waitForServer(`${baseURL}/`, {
          settleOks: 2,
          getOutput: () => ({ stdout, stderr }),
        });
        await use(baseURL);
      } finally {
        await servers.dispose();
      }
    },
    { scope: "worker" },
  ],
});

export { expect };

export function devURL(baseURL, p = "./") {
  return new URL(p, baseURL).href;
}
