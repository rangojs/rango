import { test as setup } from "@playwright/test";
import { x } from "tinyexec";

setup("build stress demo", async () => {
  await x("pnpm", ["build"], { nodeOptions: { cwd: process.cwd() } });
});
