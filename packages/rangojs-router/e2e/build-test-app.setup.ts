import { test } from "@playwright/test";
import path from "node:path";
import { x } from "tinyexec";

test("build test-app", async () => {
  const cwd = path.resolve("./e2e/test-app");
  await x("pnpm", ["build"], { nodeOptions: { cwd } });
});
