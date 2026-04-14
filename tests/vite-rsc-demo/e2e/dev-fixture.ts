import { spawn } from "node:child_process";
import { stripVTControlCharacters, styleText } from "node:util";
import { test as base, expect } from "@playwright/test";
import { x } from "tinyexec";

type DevServerFixture = {
  devServerURL: string;
};

export const test = base.extend<{}, DevServerFixture>({
  devServerURL: [
    async ({}, use) => {
      const child = x("pnpm", ["dev"], {
        nodeOptions: { cwd: process.cwd() },
      }).process!;

      const label = "[.:dev]";
      let stdout = "";

      const portPromise = new Promise<number>((resolve) => {
        child.stdout!.on("data", (data) => {
          const str = String(data);
          stdout += stripVTControlCharacters(str);
          if (process.env.TEST_DEBUG) {
            console.log(styleText("cyan", label), str);
          }
          // Also match 127.0.0.1 because vite prints the resolved bind
          // address, which is 127.0.0.1 when Node's DNS order is ipv4first
          // (set in CI to work around the container /etc/hosts preferring
          // ::1 for localhost while vite binds to 127.0.0.1 only).
          const match = stdout.match(
            /http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/,
          );
          if (match) {
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

      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
      } else {
        child.kill();
      }
      await new Promise<void>((resolve) => {
        child.on("exit", () => resolve());
      });
    },
    { scope: "worker" },
  ],
});

export { expect };

export function devURL(baseURL: string, path: string = "./") {
  return new URL(path, baseURL).href;
}
