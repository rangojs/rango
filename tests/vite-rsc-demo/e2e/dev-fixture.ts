import { spawn } from "node:child_process";
import { stripVTControlCharacters, styleText } from "node:util";
import { test as base, expect } from "@playwright/test";
import { assertFixtureModeMatchesProject, ServerGuard } from "@shared/e2e";
import { x } from "tinyexec";

type DevServerFixture = {
  devServerURL: string;
};

export const test = base.extend<{}, DevServerFixture>({
  devServerURL: [
    async ({}, use, workerInfo) => {
      // A dev server serves the dev project only; a "(production)" describe
      // written with devTest would run against it in the production project.
      assertFixtureModeMatchesProject("dev", {
        titlePath: base.info().titlePath,
        project: workerInfo.project,
      });
      // detached makes the child a process-group leader, so the guard's kill
      // reaches vite, the grandchild pnpm spawns. A plain child.kill() stops
      // only pnpm and leaves vite running.
      const child = x("pnpm", ["dev"], {
        nodeOptions: { cwd: process.cwd(), detached: true },
      }).process!;
      const done = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
      const servers = new ServerGuard();
      // Tracked as soon as it is spawned, before anything is awaited.
      servers.track({
        pid: child.pid,
        done,
        kill: (signal = "SIGTERM") => {
          if (process.platform === "win32") {
            spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
            return;
          }
          try {
            process.kill(-child.pid!, signal);
          } catch {
            child.kill(signal);
          }
        },
      });

      try {
        const label = "[.:dev]";
        let stdout = "";

        const portPromise = new Promise<number>((resolve, reject) => {
          // Fail fast, and let the finally below stop the server, instead of
          // hanging the fixture until its timeout abandons it.
          const timeout = setTimeout(() => {
            reject(
              new Error(
                `${label} timed out waiting for the dev server to start.\nStdout: ${stdout}`,
              ),
            );
          }, 60000);
          child.once("exit", (code) => {
            clearTimeout(timeout);
            reject(
              new Error(
                `${label} exited (code ${code}) before printing a URL.\nStdout: ${stdout}`,
              ),
            );
          });
          child.stdout!.on("data", (data) => {
            const str = String(data);
            stdout += stripVTControlCharacters(str);
            if (process.env.TEST_DEBUG) {
              console.log(styleText("cyan", label), str);
            }
            const match = stdout.match(/http:\/\/localhost:(\d+)/);
            if (match) {
              clearTimeout(timeout);
              resolve(Number(match[1]));
            }
          });
        });

        child.stderr!.on("data", (data) => {
          if (process.env.TEST_DEBUG) {
            console.log(styleText("magenta", label), data.toString());
          }
        });

        const port = await portPromise;
        const baseURL = `http://localhost:${port}`;
        await use(baseURL);
      } finally {
        await servers.dispose();
      }
    },
    { scope: "worker" },
  ],
});

export { expect };

export function devURL(baseURL: string, path: string = "./") {
  return new URL(path, baseURL).href;
}
