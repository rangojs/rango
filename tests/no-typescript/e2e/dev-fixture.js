import { stripVTControlCharacters, styleText } from "node:util";
import { test as base, expect } from "@playwright/test";
import { x } from "tinyexec";
import { waitForServer } from "./helper.js";

// Worker-scoped dev server: one `vite dev` per Playwright worker, shared by all
// dev tests on that worker.
export const test = base.extend({
  devServerURL: [
    async ({}, use) => {
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

      const baseURL = await urlPromise;
      // "Port printed" != "ready to serve": wait for two consecutive OK
      // responses so the first SSR request's dep-optimizer cycle is absorbed
      // before any test navigates (otherwise the first nav can ERR_EMPTY_RESPONSE).
      try {
        await waitForServer(`${baseURL}/`, {
          settleOks: 2,
          getOutput: () => ({ stdout, stderr }),
        });
      } catch (err) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        throw err;
      }
      await use(baseURL);

      // Signal the whole process group so the vite grandchild dies too.
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      await new Promise((resolve) => {
        child.on("exit", () => resolve());
      });
    },
    { scope: "worker" },
  ],
});

export { expect };

export function devURL(baseURL, p = "./") {
  return new URL(p, baseURL).href;
}
